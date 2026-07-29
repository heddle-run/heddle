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
 *   execute, apply, after                           →  an RPC call
 *
 * The synchronous hooks stay synchronous because the manifest already holds
 * their answers, which is the reason the manifest exists.
 */
import type { PluginManifest, ManifestComponent } from './manifest.js';
import type { PluginHost } from './host.js';
import { toolRunner } from './services.js';
import { checkSchema } from './schema.js';
import { PluginError } from '../errors.js';
import type { Dependencies } from '../node/types.js';
import type {
  PluginComponent,
  PluginComponentDef,
  PluginMiddlewareDef,
  PluginMiddlewareExecutor,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginResult,
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
} from './types.js';
import { readAfterVerdict, type AfterVerdict } from './protocol.js';
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

function checkComponent(entry: ManifestComponent, component: PluginComponent): void {
  if (!entry.schema) return;
  checkSchema(component, entry.schema, `${entry.componentType} "${component.name}"`);
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
      host().setToolRunner(
        toolRunner(nameOf(manifest.name, entry.componentType, node.name), deps),
      );

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
            {
              signal: ctx.signal,
              // The context heddle built for this node, handed over piece by
              // piece. What a remote plugin's `emitEvent`, `runTool` and
              // `callModel` reach are therefore the very functions an
              // in-process one calls directly — the namespace, the attribution,
              // the tool scope and the model config all come from one place,
              // and the two paths cannot drift into doing different things.
              reporter: ctx,
              // Bound to the tool scope heddle opened for this execution, so a
              // tool the plugin runs sees the workspace the plugin was told
              // about — and gets the run's signal, which the host-wide runner
              // drops.
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return asResult(manifest.name, entry.componentType, node.name, raw);
        },
      };
    },
  };

  // Assigned only when the manifest declares them, so a component that says
  // nothing about its inputs leaves them undefined rather than empty — the
  // deserializer treats those differently.
  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }
  if (entry.inputs) def.inferInputs = () => entry.inputs!;
  if (entry.outputs) def.inferOutputs = () => entry.outputs!;
  if (entry.branches) def.branches = () => entry.branches!;

  return def;
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
        toolRunner(nameOf(manifest.name, entry.componentType, component.name), deps),
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
            {
              signal: ctx.signal,
              // As a node's, and carrying the same attribution decision: a
              // transform's events name the agent it hangs off, because the
              // chain built this context knowing which agent that is and a
              // transform holds no position in the graph of its own.
              reporter: ctx,
              // A transform's own, which is scopeless — the same throwaway
              // session per call it gets in process. Passed rather than left to
              // the host's fallback so that what a transform may do stops
              // depending on whether an unrelated node compiled first.
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return asTransformResult(manifest.name, entry.componentType, raw);
        },
      };
    },
  };

  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }

  return def;
}

/**
 * The middleware half: a seam hook executed in the plugin's process.
 *
 * The one kind with no spec component behind it. `createMiddleware` therefore
 * takes the operator's configuration where the others take a document's
 * component, and `validate` becomes `validateConfig` — the manifest's `schema`
 * describes that configuration, because there is no document for it to
 * describe. The check runs where the configuration arrives, in
 * `MiddlewareChain.build`, and not here: this function is handed a manifest,
 * and the operator's answer to it turns up later.
 */
export function remoteMiddlewareDef(
  manifest: PluginManifest,
  entry: ManifestComponent,
  host: () => PluginHost,
): PluginMiddlewareDef {
  return {
    componentType: entry.componentType,
    seams: entry.seams ?? {},

    validateConfig(config): void {
      if (!entry.schema) return;
      checkSchema(
        config,
        entry.schema,
        `plugin "${manifest.name}": configuration for "${entry.componentType}"`,
      );
    },

    createMiddleware(config, deps): PluginMiddlewareExecutor {
      const wire = serializable(config, `${entry.componentType} configuration`);
      // The same wiring a transform gets, and for the same reason: what a
      // component may do has to follow from the component, not from which other
      // component of the same plugin happened to compile first. Without this a
      // middleware's `runTool` would work only when the plugin also shipped a
      // node that had already run — `setToolRunner` is first-writer-wins.
      host().setToolRunner(
        toolRunner(`plugin "${manifest.name}": middleware "${entry.componentType}"`, deps),
      );

      return {
        async after({ subject, outcome }, ctx): Promise<AfterVerdict> {
          const raw = await host().call(
            'after',
            {
              seam: ctx.seam,
              componentType: entry.componentType,
              component: wire,
              subject,
              outcome,
              attempt: ctx.attempt,
              maxAttempts: ctx.maxAttempts,
            },
            {
              signal: ctx.signal,
              // Handed over whole, exactly as a node's is, so a remote
              // middleware's events, logs, tools and model calls are the ones
              // heddle built for this consult rather than a second set that has
              // to be kept identical to them.
              reporter: ctx,
              runTool: ctx.runTool,
              callModel: ctx.callModel,
            },
          );
          return readAfterVerdict(
            ctx.seam,
            raw,
            `middleware "${entry.componentType}" (plugin "${manifest.name}")`,
          );
        },
      };
    },
  };
}

/** A component type that is neither node nor transform: validation only. */
export function remoteComponentDef(entry: ManifestComponent): PluginComponentDef {
  const def: PluginComponentDef = { componentType: entry.componentType };
  if (entry.schema) {
    def.validate = (component) => checkComponent(entry, component);
  }
  return def;
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

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PluginError(`${where} returned ${typeOf(raw)}, expected { output, branch? }`);
  }
  const result = raw as Record<string, unknown>;

  if (typeof result.output !== 'object' || result.output === null || Array.isArray(result.output)) {
    throw new PluginError(`${where} returned no "output" object`);
  }
  if (result.branch !== undefined && typeof result.branch !== 'string') {
    throw new PluginError(`${where} returned a non-string "branch"`);
  }

  return {
    output: result.output as Record<string, unknown>,
    branch: result.branch as string | undefined,
  };
}

const ACTIONS = new Set(['pass', 'modify', 'reject']);

function asTransformResult(
  plugin: string,
  componentType: string,
  raw: unknown,
): TransformResult {
  const where = `plugin "${plugin}": ${componentType}`;

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PluginError(`${where} returned ${typeOf(raw)}, expected { action, ... }`);
  }
  const result = raw as Record<string, unknown>;

  if (typeof result.action !== 'string' || !ACTIONS.has(result.action)) {
    throw new PluginError(
      `${where} returned action ${JSON.stringify(result.action)}; expected pass, modify or reject`,
    );
  }
  if (result.action === 'modify' && !Array.isArray(result.messages)) {
    throw new PluginError(`${where} returned action "modify" without "messages"`);
  }

  return {
    action: result.action as TransformResult['action'],
    messages: result.messages as Message[] | undefined,
    reason: typeof result.reason === 'string' ? result.reason : undefined,
  };
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * How a component is named in an error raised on its behalf.
 *
 * The plugin as well as the component, because out of process the plugin is the
 * unit an operator installed, killed or sandboxed — and two plugins are free to
 * provide the same `componentType`.
 */
function nameOf(plugin: string, componentType: string, componentName: string): string {
  return `plugin "${plugin}": ${componentType} "${componentName}"`;
}

export type { TransformPhase };
