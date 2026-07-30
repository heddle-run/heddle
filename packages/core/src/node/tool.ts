import type { ToolNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { invokeTool } from '../tool/invoke.js';
import { RunError, ToolError } from '../errors.js';

export class ToolNodeExecutor implements NodeExecutor {
  private readonly node: ToolNode;
  private readonly deps: Dependencies;

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
    const result = await invokeTool(
      signal,
      this.resolveTool(),
      input.toData(),
      this.deps.toolExecutor,
    );

    return new State(result.output);
  }

  private resolveTool() {
    const { tool } = this.node;
    if (!tool) {
      throw new RunError(`ToolNode "${this.node.name}" has no tool`);
    }

    const registry = this.deps.toolRegistry;
    if (!registry) {
      throw new RunError(
        `ToolNode "${this.node.name}": no tool registry configured`,
      );
    }

    const definition = registry.lookup(tool.name);
    if (!definition) {
      throw new ToolError(
        `ToolNode "${this.node.name}": tool "${tool.name}" not found`,
      );
    }

    return definition;
  }
}
