import type { Outcome, SchemaMap, Step } from '../spec/types.js';
import type { SpecEdge } from '../spec/resolve.js';
import type { NodeExecutor } from '../node/types.js';

export interface DataSource {
  sourceNode: string;
  sourceOutput: string;
}

/**
 * What a compiled node was lowered from: the flow's inputs, one of its steps,
 * or one of its outcomes.
 */
export type GraphNodeSpec =
  | { role: 'inputs'; inputs: SchemaMap }
  | { role: 'step'; step: Step }
  | { role: 'outcome'; outcome: Outcome };

export interface CompiledNode {
  name: string;
  /**
   * The node's kind as events report it: `start`, `outcome`, a step verb
   * (`agent`, `llm`, `tool`, `switch`), or a plugin component type.
   */
  type: string;
  spec: GraphNodeSpec;
  executor: NodeExecutor;
  edges: SpecEdge[];
  /**
   * Each `{{ref}}` the node makes, as the dotted key it resolves under and
   * where the runner reads it from. Derived from the templates, never written
   * by hand.
   */
  inputMappings: Map<string, DataSource>;
}

const UNBRANCHED = '';

export class CompiledGraph {
  constructor(
    public name: string,
    public nodes: Map<string, CompiledNode>,
    public start: string,
  ) {}

  getNode(name: string): CompiledNode | undefined {
    return this.nodes.get(name);
  }

  /** A terminal node: reaching one ends the run. */
  isTerminal(node: CompiledNode): boolean {
    return node.spec.role === 'outcome';
  }

  nextNode(current: CompiledNode, branch: string): CompiledNode | undefined {
    return this.matchingBranch(current, branch) ?? this.unbranchedEdge(current);
  }

  private matchingBranch(
    current: CompiledNode,
    branch: string,
  ): CompiledNode | undefined {
    if (branch === UNBRANCHED) return undefined;

    for (const edge of current.edges) {
      if (edge.branch !== branch) continue;
      const next = this.nodes.get(edge.to);
      if (next) return next;
    }
    return undefined;
  }

  private unbranchedEdge(current: CompiledNode): CompiledNode | undefined {
    for (const edge of current.edges) {
      if ((edge.branch ?? UNBRANCHED) !== UNBRANCHED) continue;
      const next = this.nodes.get(edge.to);
      if (next) return next;
    }
    return undefined;
  }
}
