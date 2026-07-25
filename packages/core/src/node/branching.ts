import type { BranchingNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { RunError } from '../errors.js';

const DEFAULT_BRANCH = 'DEFAULT_BRANCH';

/** BranchingExecutor executes a BranchingNode by routing based on a mapping. */
export class BranchingExecutor implements NodeExecutor {
  private node: BranchingNode;
  private _branch = '';

  constructor(node: BranchingNode, _deps: Dependencies) {
    this.node = node;
  }

  branch(): string {
    return this._branch;
  }

  async execute(
    _signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    let keyValue = input.getString('branching_mapping_key');

    if (keyValue === undefined) {
      for (const key of input.keys()) {
        const v = input.getString(key);
        if (v !== undefined) {
          keyValue = v;
          break;
        }
      }
      if (keyValue === undefined) {
        throw new RunError(
          `BranchingNode "${this.node.name}": no branching_mapping_key in input`,
        );
      }
    }

    if (keyValue in this.node.mapping) {
      this._branch = this.node.mapping[keyValue];
    } else if (DEFAULT_BRANCH in this.node.mapping) {
      this._branch = this.node.mapping[DEFAULT_BRANCH];
    } else {
      this._branch = 'default';
    }

    return input.clone();
  }
}

/** PassthroughExecutor passes inputs through unchanged (used for Start and End nodes). */
export class PassthroughExecutor implements NodeExecutor {
  branch(): string {
    return '';
  }

  async execute(
    _signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    return input.clone();
  }
}
