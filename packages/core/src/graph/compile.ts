import type { AnyNode, ParsedFlow, SpecNode } from '../spec/types.js';
import type { Dependencies, NodeExecutor } from '../node/types.js';
import { PluginNodeAdapter } from '../plugin/executor.js';
import type { PluginNode } from '../plugin/types.js';
import { PassthroughExecutor, BranchingExecutor } from '../node/branching.js';
import { AgentExecutor } from '../node/agent.js';
import { LLMExecutor } from '../node/llm.js';
import { ToolNodeExecutor } from '../node/tool.js';
import { CompiledGraph, type CompiledNode } from './types.js';
import { CompileError } from '../errors.js';

/**
 * Turn a parsed flow into something a `Runner` can walk: every node paired
 * with the executor that will run it, every edge attached to its source.
 *
 * This is where `deps` is bound — the tool registry, the provider, the plugin
 * registry all reach a node's executor here, so a graph compiled against one
 * set of dependencies runs against that set for its whole life. Compiling is
 * cheap and starts nothing (no plugin process, no model call), which is why a
 * compiled graph can be built once and run many times. Run `validate` on the
 * result before trusting it: `compile` refuses only what it cannot build, not
 * what will strand a run.
 */
export function compile(flow: ParsedFlow, deps: Dependencies): CompiledGraph {
  const nodes = compileNodes(flow, deps);
  const start = findStartNode(nodes);

  attachControlFlowEdges(flow, nodes);
  attachDataFlowEdges(flow, nodes);

  return new CompiledGraph(
    flow.name,
    nodes,
    start,
    flow.dataFlowConnections ?? [],
  );
}

function compileNodes(
  flow: ParsedFlow,
  deps: Dependencies,
): Map<string, CompiledNode> {
  const nodes = new Map<string, CompiledNode>();

  for (const specNode of flow.parsedNodes) {
    nodes.set(specNode.name, {
      name: specNode.name,
      type: specNode.componentType,
      specNode,
      executor: buildExecutor(specNode, deps),
      edges: [],
      inputMappings: new Map(),
    });
  }

  return nodes;
}

function findStartNode(nodes: Map<string, CompiledNode>): string {
  for (const [name, node] of nodes) {
    if (node.type === 'StartNode') return name;
  }
  throw new CompileError('no StartNode found');
}

function attachControlFlowEdges(
  flow: ParsedFlow,
  nodes: Map<string, CompiledNode>,
): void {
  for (const edge of flow.controlFlowConnections) {
    const source = nodes.get(edge.fromNode);
    if (!source) {
      throw new CompileError(
        `control flow edge fromNode "${edge.fromNode}" not found`,
      );
    }
    source.edges.push(edge);
  }
}

function attachDataFlowEdges(
  flow: ParsedFlow,
  nodes: Map<string, CompiledNode>,
): void {
  for (const edge of flow.dataFlowConnections ?? []) {
    const destination = nodes.get(edge.destinationNode);
    if (!destination) {
      throw new CompileError(
        `data flow edge destinationNode "${edge.destinationNode}" not found`,
      );
    }
    destination.inputMappings.set(edge.destinationInput, {
      sourceNode: edge.sourceNode,
      sourceOutput: edge.sourceOutput,
    });
  }
}

function buildExecutor(node: AnyNode, deps: Dependencies): NodeExecutor {
  const pluginDef = deps.plugins?.nodeDef(node.componentType);
  if (pluginDef) {
    return new PluginNodeAdapter(node as unknown as PluginNode, pluginDef, deps);
  }
  return buildBuiltinExecutor(node, deps);
}

function buildBuiltinExecutor(node: AnyNode, deps: Dependencies): NodeExecutor {
  const builtin = node as SpecNode;
  switch (builtin.componentType) {
    case 'StartNode':
    case 'EndNode':
      return new PassthroughExecutor();
    case 'AgentNode':
      return new AgentExecutor(builtin, deps);
    case 'LlmNode':
      return new LLMExecutor(builtin, deps);
    case 'ToolNode':
      return new ToolNodeExecutor(builtin, deps);
    case 'BranchingNode':
      return new BranchingExecutor(builtin, deps);
    default:
      throw new CompileError(unknownNodeTypeMessage(node, deps));
  }
}

function unknownNodeTypeMessage(node: AnyNode, deps: Dependencies): string {
  const loaded = deps.plugins?.describe() ?? 'none';
  return (
    `node "${node.name}" has type "${node.componentType}", which no builtin or ` +
    `plugin provides. Loaded plugins: ${loaded}`
  );
}
