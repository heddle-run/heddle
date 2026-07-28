/**
 * Presents an out-of-process plugin through the same interfaces an in-process
 * one implements.
 *
 * This is what keeps the redesign contained. `compile()` asks the registry for
 * a `PluginNodeDef` and builds a `PluginNodeAdapter` around it; neither has to
 * learn that a plugin might live in another process. The difference is only in
 * where each hook's answer comes from:
 *
 *   validate, inferInputs, inferOutputs, branches   →  the manifest (data)
 *   execute, apply                                  →  an RPC call
 *
 * The synchronous hooks stay synchronous because the manifest already holds
 * their answers, which is the reason the manifest exists.
 */
import type { PluginManifest, ManifestComponent } from './manifest.js';
import type { PluginHost, ToolRunner } from './host.js';
import { checkSchema } from './schema.js';
import { PluginError } from '../errors.js';
import { isObject, typeName } from '../json.js';
import type { Dependencies } from '../node/types.js';
import { runRegisteredTool } from '../tool/run.js';
import { isTransformAction, TRANSFORM_ACTIONS_PROSE } from './types.js';
import type {
  PluginComponent,
  PluginComponentDef,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginResult,
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
} from './types.js';
import type { Message } from '../llm/types.js';

/**
 * Strip a component to what can cross a pipe.
 *
 * Spec components carry agentspec `Property` instances and may hold cycles
 * through referenced components. A round trip through JSON is the cheap way to
 * guarantee the plugin receives something it can parse, and to guarantee heddle
 * notices here — rather than as a truncated write — when it cannot.
 */
function serializable(value: unknown, what: string): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (err) {
    throw new PluginError(`${what} cannot be serialized for an out-of-process plugin`, {
      cause: err,
    });
  }
}

/**
 * Give a def the manifest's schema check, when the manifest declared one.
 *
 * Assigned rather than always present, because `validate` being absent is what
 * tells the deserializer there is nothing to check — and all three kinds of
 * remote def need it on exactly the same condition.
 */
function validating<D extends PluginComponentDef>(def: D, entry: ManifestComponent): D {
  if (entry.schema) {
    def.validate = (component) =>
      checkSchema(component, entry.schema!, `${entry.componentType} "${component.name}"`);
  }
  return def;
}

/** The node half: a custom node type executed in the plugin's process. */
export function remoteNodeDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginNodeDef {
  const def: PluginNodeDef = {
    componentType: entry.componentType,

    createExecutor(node: PluginNode, deps): PluginNodeExecutor {
      const wire = serializable(node, `${entry.componentType} "${node.name}"`);
      // The compiled graph's dependencies are the first place a tool registry
      // exists, so this is where the plugin's `runTool` gets something to call.
      host().setToolRunner(toolRunner(manifest.name, entry.componentType, node.name, deps));

      return {
        async execute(input, ctx): Promise<PluginResult> {
          // The run's signal goes with the call. An in-process plugin is free
          // to ignore `ctx.signal` and the run still ends when its own stack
          // unwinds; a remote one is a process heddle is blocked on, so an
          // abort that does not reach the host holds the run's concurrency
          // slot until the plugin's per-call timer fires instead.
          const raw = await host().call(
            'execute',
            {
              componentType: entry.componentType,
              node: wire,
              input,
              // Read here rather than served as a reverse call, for the
              // reasons on `ExecuteParams.workspace` — and withheld when the
              // plugin's own process is confined, because the node's scope is
              // a different sandbox session and its path is one the plugin
              // cannot open. Sending it anyway would be the one thing that
              // field must not do. The cost of sending it is visible at this
              // line: without a sandbox `getWorkspace` creates the directory
              // whether or not the plugin ever opens it, so a confined plugin
              // is also spared a mkdtemp for a path it could not use.
              ...(host().confined
                ? { workspaceUnavailable: 'confined' as const }
                : { workspace: ctx.getWorkspace() }),
            },
            ctx.signal,
            undefined,
            // The context heddle built for this node, handed over whole. What
            // a remote plugin's `emitEvent` reaches is therefore the same
            // object an in-process one calls directly — the namespace, the
            // attribution and the name check come from one place, and the two
            // paths cannot drift into publishing different events.
            ctx,
            // The same trade for tools, and the half that was missing. This
            // node's `runTool` is bound to the tool scope heddle opened for
            // this execution, so a tool the plugin runs sees the workspace the
            // plugin was told about — and gets the run's signal, which the
            // host-wide runner below drops.
            ctx.runTool,
          );
          return asResult(manifest.name, entry.componentType, node.name, raw);
        },
      };
    },
  };

  // Assigned only when the manifest declares them, so a component that says
  // nothing about its inputs leaves them undefined rather than empty — the
  // deserializer treats those differently.
  if (entry.inputs) def.inferInputs = () => entry.inputs!;
  if (entry.outputs) def.inferOutputs = () => entry.outputs!;
  if (entry.branches) def.branches = () => entry.branches!;

  return validating(def, entry);
}

/** The transform half: a message transform executed in the plugin's process. */
export function remoteTransformDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginTransformDef {
  const def: PluginTransformDef = {
    componentType: entry.componentType,

    phase: () => entry.phase ?? 'pre',

    createTransform(component: PluginComponent, deps): PluginTransformExecutor {
      const wire = serializable(component, `${entry.componentType} "${component.name}"`);
      // Same wiring as a node's, and for the same reason: what a plugin may do
      // has to follow from the plugin, not from where in the spec it was
      // written. A guardrail that consults a classifier tool is the ordinary
      // case, and without this it reached a host with no runner and was told it
      // had no tool access.
      host().setToolRunner(
        toolRunner(manifest.name, entry.componentType, component.name, deps),
      );

      return {
        async apply(messages: Message[], ctx): Promise<TransformResult> {
          // Carried for the same reason a node's is: a transform runs inside an
          // agent turn, which is the longest a run can be blocked on one call.
          const raw = await host().call(
            'apply',
            {
              componentType: entry.componentType,
              component: wire,
              phase: ctx.phase,
              messages,
            },
            ctx.signal,
            undefined,
            // As a node's, and carrying the same attribution decision: a
            // transform's events name the agent it hangs off, because the
            // chain built this context knowing which agent that is and a
            // transform holds no position in the graph of its own.
            ctx,
          );
          return asTransformResult(manifest.name, entry.componentType, raw);
        },
      };
    },
  };

  return validating(def, entry);
}

/** A component type that is neither node nor transform: validation only. */
export function remoteComponentDef(entry: ManifestComponent): PluginComponentDef {
  return validating({ componentType: entry.componentType }, entry);
}

/**
 * Check what came back over the pipe.
 *
 * The in-process adapter already checks the shape of a plugin's return value,
 * but it can trust that the value is at least a JS object of the plugin's own
 * making. Here it is parsed JSON from another process, so the checks have to
 * happen before the value is handed on as a node's output.
 */
function asResult(
  plugin: string,
  componentType: string,
  nodeName: string,
  raw: unknown,
): PluginResult {
  const where = `plugin "${plugin}": ${componentType} "${nodeName}"`;

  if (!isObject(raw)) {
    throw new PluginError(`${where} returned ${typeName(raw)}, expected { output, branch? }`);
  }
  const result = raw;

  if (!isObject(result.output)) {
    throw new PluginError(`${where} returned no "output" object`);
  }
  if (result.branch !== undefined && typeof result.branch !== 'string') {
    throw new PluginError(`${where} returned a non-string "branch"`);
  }

  return {
    output: result.output,
    branch: result.branch as string | undefined,
  };
}

function asTransformResult(
  plugin: string,
  componentType: string,
  raw: unknown,
): TransformResult {
  const where = `plugin "${plugin}": ${componentType}`;

  if (!isObject(raw)) {
    throw new PluginError(`${where} returned ${typeName(raw)}, expected { action, ... }`);
  }
  const result = raw;

  if (typeof result.action !== 'string' || !isTransformAction(result.action)) {
    throw new PluginError(
      `${where} returned action ${JSON.stringify(result.action)}; expected ` +
        `${TRANSFORM_ACTIONS_PROSE}`,
    );
  }
  if (result.action === 'modify' && !Array.isArray(result.messages)) {
    throw new PluginError(`${where} returned action "modify" without "messages"`);
  }

  return {
    action: result.action,
    messages: result.messages as Message[] | undefined,
    reason: typeof result.reason === 'string' ? result.reason : undefined,
  };
}

/**
 * The `runTool` a plugin's reverse calls fall back to.
 *
 * Scopeless, and that is what makes it a fallback rather than the path. The
 * executor's own confinement still applies to each tool, but a tool started
 * here gets a throwaway sandbox session, so it shares a workspace with nothing
 * — including the node that asked for it. A node's own `runTool` therefore goes
 * through {@link PluginHost.call}'s `runTool` argument instead, and this serves
 * the two cases that have no scope to offer: a transform, which owns none, and
 * a plugin hand-rolling the protocol that sends no `call` id.
 *
 * One host serves every component of one plugin, and the host keeps the first
 * runner it is given. The runners differ only in the component they name in an
 * error, so which one wins does not change what a plugin may do.
 */
function toolRunner(
  plugin: string,
  componentType: string,
  componentName: string,
  deps: Dependencies,
): ToolRunner {
  const where = `plugin "${plugin}": ${componentType} "${componentName}"`;
  return (name, input) =>
    runRegisteredTool(deps, undefined, name, input, where);
}

export type { TransformPhase };
