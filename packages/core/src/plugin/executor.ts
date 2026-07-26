/**
 * Adapts a plugin's executor to heddle's internal NodeExecutor interface.
 *
 * Plugin authors work with plain objects — input in, `{ output, branch }` out —
 * so a plugin module never has to import heddle's State class or match its
 * two-call execute/branch protocol.
 */
import { State } from '../state/state.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import type { Executor } from '../tool/types.js';
import type { PluginContext, PluginNode, PluginNodeDef } from './types.js';
import { PluginError, RunError, ToolError } from '../errors.js';

export class PluginNodeAdapter implements NodeExecutor {
  private node: PluginNode;
  private deps: Dependencies;
  private impl: ReturnType<PluginNodeDef['createExecutor']>;
  private declaredBranches: Set<string>;
  private _branch = '';

  constructor(node: PluginNode, def: PluginNodeDef, deps: Dependencies) {
    this.node = node;
    this.deps = deps;
    this.impl = def.createExecutor(node, deps);
    this.declaredBranches = new Set(node.branches ?? []);
  }

  branch(): string {
    return this._branch;
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    // One sandbox session per node execution, matching AgentExecutor: the
    // tools a plugin node runs share a workspace with each other only.
    const scope = this.deps.toolExecutor?.beginScope?.(this.node.name);
    try {
      return await this.runNode(signal, input, scope?.executor);
    } finally {
      scope?.dispose();
    }
  }

  private async runNode(
    signal: AbortSignal | undefined,
    input: State,
    scoped: Executor | undefined,
  ): Promise<State> {
    const ctx: PluginContext = {
      signal,
      node: this.node,
      runTool: (name, toolInput) => this.runTool(signal, name, toolInput, scoped),
    };

    const result = await this.impl.execute(input.toData(), ctx);

    if (!result || typeof result !== 'object') {
      throw new PluginError(
        `${this.node.componentType} "${this.node.name}": executor must return ` +
          `{ output, branch? }, got ${typeof result}`,
      );
    }
    if (!result.output || typeof result.output !== 'object') {
      throw new PluginError(
        `${this.node.componentType} "${this.node.name}": executor returned no "output" object`,
      );
    }

    const branch = result.branch ?? '';
    if (branch && !this.declaredBranches.has(branch)) {
      // Caught here rather than at routing time, where the failure would surface
      // as a confusing "no next node" error.
      throw new PluginError(
        `${this.node.componentType} "${this.node.name}": executor returned branch ` +
          `"${branch}", which is not in its declared branches ` +
          `[${[...this.declaredBranches].join(', ')}]`,
      );
    }
    this._branch = branch;

    return new State(result.output);
  }

  private async runTool(
    signal: AbortSignal | undefined,
    name: string,
    input: Record<string, unknown>,
    scoped?: Executor,
  ): Promise<Record<string, unknown>> {
    const { toolRegistry } = this.deps;
    const toolExecutor = scoped ?? this.deps.toolExecutor;
    if (!toolRegistry || !toolExecutor) {
      throw new RunError(
        `${this.node.componentType} "${this.node.name}": no tool registry configured`,
      );
    }
    const tool = toolRegistry.lookup(name);
    if (!tool) {
      throw new ToolError(
        `${this.node.componentType} "${this.node.name}": tool "${name}" not found`,
      );
    }
    const result = await toolExecutor.execute(signal, tool.path, input);
    return result.output;
  }
}
