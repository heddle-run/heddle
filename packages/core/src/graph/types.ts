import type { AnyNode, ControlFlowEdge, DataFlowEdge } from '../spec/types.js';
import type { NodeExecutor } from '../node/types.js';

export interface DataSource {
  sourceNode: string;
  sourceOutput: string;
}

export interface CompiledNode {
  name: string;
  type: string;
  specNode: AnyNode;
  executor: NodeExecutor;
  edges: ControlFlowEdge[];
  inputMappings: Map<string, DataSource>;
}

const UNBRANCHED = '';

export class CompiledGraph {
  constructor(
    public name: string,
    public nodes: Map<string, CompiledNode>,
    public start: string,
    public dataFlowEdges: DataFlowEdge[],
  ) {}

  getNode(name: string): CompiledNode | undefined {
    return this.nodes.get(name);
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
      if (edge.fromBranch !== branch) continue;
      const next = this.nodes.get(edge.toNode);
      if (next) return next;
    }
    return undefined;
  }

  private unbranchedEdge(current: CompiledNode): CompiledNode | undefined {
    for (const edge of current.edges) {
      if ((edge.fromBranch ?? UNBRANCHED) !== UNBRANCHED) continue;
      const next = this.nodes.get(edge.toNode);
      if (next) return next;
    }
    return undefined;
  }
}
