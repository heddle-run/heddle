import type { ParsedFlow, SpecNode } from '../spec/types.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import { PassthroughExecutor, BranchingExecutor } from '../node/branching.js';
import { AgentExecutor } from '../node/agent.js';
import { LLMExecutor } from '../node/llm.js';
import { ToolNodeExecutor } from '../node/tool.js';
import { CompiledGraph, type CompiledNode, type DataSource } from './types.js';
import { CompileError } from '../errors.js';

/** Compile converts a ParsedFlow into a CompiledGraph ready for execution. */
export function compile(
  pf: ParsedFlow,
  deps: Dependencies,
): CompiledGraph {
  const nodes = new Map<string, CompiledNode>();
  let start = '';

  for (const n of pf.parsedNodes) {
    const name = n.name;
    const executor = buildExecutor(n, deps);

    const cn: CompiledNode = {
      name,
      type: n.componentType,
      specNode: n,
      executor,
      edges: [],
      inputMappings: new Map(),
    };

    if (n.componentType === 'StartNode') {
      start = name;
    }

    nodes.set(name, cn);
  }

  if (!start) {
    throw new CompileError('no StartNode found');
  }

  // Attach control flow edges to nodes
  for (const edge of pf.controlFlowConnections) {
    const cn = nodes.get(edge.fromNode);
    if (!cn) {
      throw new CompileError(
        `control flow edge fromNode "${edge.fromNode}" not found`,
      );
    }
    cn.edges.push(edge);
  }

  // Build data flow input mappings per node
  const dataEdges = pf.dataFlowConnections ?? [];
  for (const edge of dataEdges) {
    const cn = nodes.get(edge.destinationNode);
    if (!cn) {
      throw new CompileError(
        `data flow edge destinationNode "${edge.destinationNode}" not found`,
      );
    }
    cn.inputMappings.set(edge.destinationInput, {
      sourceNode: edge.sourceNode,
      sourceOutput: edge.sourceOutput,
    });
  }

  return new CompiledGraph(pf.name, nodes, start, dataEdges);
}

function buildExecutor(n: SpecNode, deps: Dependencies): NodeExecutor {
  switch (n.componentType) {
    case 'StartNode':
    case 'EndNode':
      return new PassthroughExecutor();
    case 'AgentNode':
      return new AgentExecutor(n, deps);
    case 'LlmNode':
      return new LLMExecutor(n, deps);
    case 'ToolNode':
      return new ToolNodeExecutor(n, deps);
    case 'BranchingNode':
      return new BranchingExecutor(n, deps);
    default:
      throw new CompileError(
        `unknown node type: ${(n as SpecNode).componentType}`,
      );
  }
}
