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
import { PluginError, RunError, ToolError } from '../errors.js';
import type { Dependencies } from '../node/types.js';
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
      host().setToolRunner(toolRunner(manifest.name, entry.componentType, node.name, deps));

      return {
        async execute(input, ctx): Promise<PluginResult> {
          const raw = await host().call('execute', {
            componentType: entry.componentType,
            node: wire,
            input,
          });
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

    createTransform(component: PluginComponent): PluginTransformExecutor {
      const wire = serializable(component, `${entry.componentType} "${component.name}"`);

      return {
        async apply(messages: Message[], ctx): Promise<TransformResult> {
          const raw = await host().call('apply', {
            componentType: entry.componentType,
            component: wire,
            phase: ctx.phase,
            messages,
          });
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
 * The `runTool` a plugin's reverse calls land on.
 *
 * Mirrors what `PluginNodeAdapter` gives an in-process plugin, with one
 * difference that matters: this runs the tool through the executor without a
 * per-node scope. A remote plugin's calls arrive on its own channel and are not
 * tied to the execute() that is on the stack, so there is no node scope to
 * borrow — the executor's own confinement still applies to each tool.
 */
function toolRunner(
  plugin: string,
  componentType: string,
  nodeName: string,
  deps: Dependencies,
): ToolRunner {
  return async (name, input) => {
    const where = `plugin "${plugin}": ${componentType} "${nodeName}"`;
    const { toolRegistry, toolExecutor } = deps;

    if (!toolRegistry || !toolExecutor) {
      throw new RunError(`${where}: no tool registry configured`);
    }
    const tool = toolRegistry.lookup(name);
    if (!tool) {
      throw new ToolError(`${where}: tool "${name}" not found`);
    }
    const result = await toolExecutor.execute(undefined, tool.path, input);
    return result.output;
  };
}

export type { TransformPhase };
