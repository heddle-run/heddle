import type { BranchingNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { RunError } from '../errors.js';

const MAPPING_KEY_INPUT = 'branching_mapping_key';
const DEFAULT_BRANCH_KEY = 'DEFAULT_BRANCH';
const FALLBACK_BRANCH = 'default';

export class BranchingExecutor implements NodeExecutor {
  private readonly node: BranchingNode;
  private selectedBranch = '';

  constructor(node: BranchingNode, _deps: Dependencies) {
    this.node = node;
  }

  branch(): string {
    return this.selectedBranch;
  }

  async execute(
    _signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    this.selectedBranch = this.branchFor(this.readMappingKey(input));
    return input.clone();
  }

  private readMappingKey(input: State): string {
    const key = input.getString(MAPPING_KEY_INPUT) ?? firstStringValue(input);
    if (key === undefined) {
      throw new RunError(
        `BranchingNode "${this.node.name}": no ${MAPPING_KEY_INPUT} in input`,
      );
    }
    return key;
  }

  private branchFor(key: string): string {
    const { mapping } = this.node;
    if (Object.hasOwn(mapping, key)) return mapping[key];
    if (Object.hasOwn(mapping, DEFAULT_BRANCH_KEY)) {
      return mapping[DEFAULT_BRANCH_KEY];
    }
    return FALLBACK_BRANCH;
  }
}

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

function firstStringValue(input: State): string | undefined {
  for (const key of input.keys()) {
    const value = input.getString(key);
    if (value !== undefined) return value;
  }
  return undefined;
}
