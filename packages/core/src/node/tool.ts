import type { ToolNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { runRegisteredTool } from '../tool/run.js';
import { RunError } from '../errors.js';

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

    const output = await runRegisteredTool(
      this.deps,
      { signal },
      this.node.tool.name,
      input.toData(),
      `ToolNode "${this.node.name}"`,
    );

    return new State(output);
  }
}
