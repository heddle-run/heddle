import { State } from '../state/state.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import type { EventHandler } from '../runner/events.js';
import { pluginEventType } from '../runner/events.js';
import type { Executor, ExecutorScope } from '../tool/types.js';
import { invokeTool } from '../tool/invoke.js';
import { createWorkspace, removeDir } from '../sandbox/workspace.js';
import type {
  PluginContext,
  PluginNode,
  PluginNodeDef,
  PluginReporter,
  PluginResult,
} from './types.js';
import { PluginModel } from './services.js';
import { PluginError, RunError, ToolError } from '../errors.js';

const NO_BRANCH = '';

export interface EventSource {
  nodeName: string;
  componentType: string;
}

export function pluginReporter(
  handler: EventHandler | undefined,
  source: EventSource,
): PluginReporter {
  return {
    emitEvent(name: string, data?: unknown): void {
      const type = pluginEventType(source.componentType, name);
      if (data !== undefined) assertSerializable(type, data);

      handler?.({
        type,
        nodeName: source.nodeName,
        nodeType: source.componentType,
        data,
      });
    },

    log(level, message): void {
      handler?.({
        type: 'plugin_log',
        nodeName: source.nodeName,
        nodeType: source.componentType,
        level,
        message,
      });
    },
  };
}

export class PluginNodeAdapter implements NodeExecutor {
  private readonly node: PluginNode;
  private readonly deps: Dependencies;
  private readonly impl: ReturnType<PluginNodeDef['createExecutor']>;
  private readonly declaredBranches: Set<string>;
  private readonly model: PluginModel;
  private selectedBranch = NO_BRANCH;
  private ownWorkspace?: string;

  constructor(node: PluginNode, def: PluginNodeDef, deps: Dependencies) {
    this.node = node;
    this.deps = deps;
    this.impl = def.createExecutor(node, deps);
    this.declaredBranches = new Set(node.branches ?? []);
    this.model = new PluginModel(this.describe(), node, deps);
  }

  branch(): string {
    return this.selectedBranch;
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const scope = this.deps.toolExecutor?.beginScope?.(this.node.name);
    try {
      return await this.runNode(signal, input, scope);
    } finally {
      scope?.dispose();
      this.discardOwnWorkspace();
    }
  }

  private async runNode(
    signal: AbortSignal | undefined,
    input: State,
    scope: ExecutorScope | undefined,
  ): Promise<State> {
    const ctx: PluginContext = {
      signal,
      node: this.node,
      runTool: (name, toolInput) =>
        this.runTool(signal, name, toolInput, scope?.executor),
      callModel: this.model.bind(signal),
      getWorkspace: () => this.workspace(scope),
      ...pluginReporter(this.deps.eventHandler, {
        nodeName: this.node.name,
        componentType: this.node.componentType,
      }),
    };

    const result = await this.impl.execute(input.toData(), ctx);
    this.assertUsableResult(result);
    this.selectedBranch = this.checkedBranch(result.branch ?? NO_BRANCH);

    return new State(result.output);
  }

  private assertUsableResult(result: PluginResult): void {
    if (!result || typeof result !== 'object') {
      throw new PluginError(
        `${this.describe()}: executor must return ` +
          `{ output, branch? }, got ${typeof result}`,
      );
    }
    if (!result.output || typeof result.output !== 'object') {
      throw new PluginError(
        `${this.describe()}: executor returned no "output" object`,
      );
    }
  }

  private checkedBranch(branch: string): string {
    if (branch && !this.declaredBranches.has(branch)) {
      throw new PluginError(
        `${this.describe()}: executor returned branch ` +
          `"${branch}", which is not in its declared branches ` +
          `[${[...this.declaredBranches].join(', ')}]`,
      );
    }
    return branch;
  }

  private async runTool(
    signal: AbortSignal | undefined,
    name: string,
    input: Record<string, unknown>,
    scopedExecutor?: Executor,
  ): Promise<Record<string, unknown>> {
    const registry = this.deps.toolRegistry;
    if (!registry) {
      throw new RunError(`${this.describe()}: no tool registry configured`);
    }

    const tool = registry.lookup(name);
    if (!tool) {
      throw new ToolError(`${this.describe()}: tool "${name}" not found`);
    }

    const result = await invokeTool(
      signal,
      tool,
      input,
      scopedExecutor ?? this.deps.toolExecutor,
    );
    return result.output;
  }

  private workspace(scope: ExecutorScope | undefined): string {
    if (scope?.workspace !== undefined) return scope.workspace;

    this.ownWorkspace ??= createWorkspace(this.node.name);
    return this.ownWorkspace;
  }

  private discardOwnWorkspace(): void {
    if (this.ownWorkspace === undefined) return;

    removeDir(this.ownWorkspace);
    this.ownWorkspace = undefined;
  }

  private describe(): string {
    return `${this.node.componentType} "${this.node.name}"`;
  }
}

function assertSerializable(type: string, data: unknown): void {
  try {
    JSON.stringify(data);
  } catch (err) {
    throw new PluginError(unserializableEventMessage(type, err), {
      cause: err,
    });
  }
}

function unserializableEventMessage(type: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return (
    `"${type}" was emitted with data that is not JSON: ${detail}. ` +
    `An event's data is written straight into the client's stream, so it has ` +
    `to be plain values — no cycles, no BigInt, no class instances that ` +
    `stringify to nothing.`
  );
}
