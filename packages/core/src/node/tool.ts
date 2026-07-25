import type { ToolNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { RunError, ToolError } from '../errors.js';

/** ToolNodeExecutor executes a ToolNode by running an external tool. */
export class ToolNodeExecutor implements NodeExecutor {
  private node: ToolNode;
  private deps: Dependencies;

  constructor(node: ToolNode, deps: Dependencies) {
    this.node = node;
    this.deps = deps;
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    if (!this.node.tool) {
      throw new RunError(`ToolNode "${this.node.name}" has no tool`);
    }

    if (!this.deps.toolRegistry) {
      throw new RunError(
        `ToolNode "${this.node.name}": no tool registry configured`,
      );
    }

    const toolDef = this.deps.toolRegistry.lookup(this.node.tool.name);
    if (!toolDef) {
      throw new ToolError(
        `ToolNode "${this.node.name}": tool "${this.node.tool.name}" not found`,
      );
    }

    if (!this.deps.toolExecutor) {
      throw new RunError(
        `ToolNode "${this.node.name}": no tool executor configured`,
      );
    }

    const result = await this.deps.toolExecutor.execute(
      signal,
      toolDef.path,
      input.toData() as Record<string, unknown>,
    );

    return new State(result.output);
  }
}
