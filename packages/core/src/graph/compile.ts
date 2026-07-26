import type { AgentNode, AnyNode, BranchingNode, LLMNode, ParsedFlow, ToolNode } from '../spec/types.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import { PluginNodeAdapter } from '../plugin/executor.js';
import type { PluginNode } from '../plugin/types.js';
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

function buildExecutor(n: AnyNode, deps: Dependencies): NodeExecutor {
  switch (n.componentType) {
    case 'StartNode':
    case 'EndNode':
      return new PassthroughExecutor();
    case 'AgentNode':
      return new AgentExecutor(n as AgentNode, deps);
    case 'LlmNode':
      return new LLMExecutor(n as LLMNode, deps);
    case 'ToolNode':
      return new ToolNodeExecutor(n as ToolNode, deps);
    case 'BranchingNode':
      return new BranchingExecutor(n as BranchingNode, deps);
    default: {
      const def = deps.plugins?.nodeDef(n.componentType);
      if (def) {
        return new PluginNodeAdapter(n as unknown as PluginNode, def, deps);
      }
      throw new CompileError(
        `node "${n.name}" has type "${n.componentType}", which no builtin or ` +
          `plugin provides. Loaded plugins: ${deps.plugins?.describe() ?? 'none'}`,
      );
    }
  }
}
