import type { ComponentBase } from 'agentspec';
import type {
  AnyNode,
  ParsedFlow,
  ControlFlowEdge,
  DataFlowEdge,
} from './types.js';
import type { PluginRegistry } from '../plugin/registry.js';
import { SpecError } from '../errors.js';

interface SdkFlow {
  componentType: string;
  name: string;
  id?: string;
  metadata?: Record<string, unknown>;
  startNode: SdkNode;
  nodes: SdkNode[];
  controlFlowConnections: SdkControlFlowEdge[];
  dataFlowConnections?: SdkDataFlowEdge[];
  inputs?: unknown[];
  outputs?: unknown[];
}

interface SdkNode {
  componentType: string;
  name: string;
  id?: string;
  metadata?: Record<string, unknown>;
  inputs?: unknown[];
  outputs?: unknown[];
  branches?: string[];
  agent?: unknown;
  mapping?: Record<string, string>;
  promptTemplate?: string;
  llmConfig?: unknown;
  tool?: unknown;
  branchName?: string;
}

interface SdkControlFlowEdge {
  fromNode: SdkNode;
  fromBranch?: string | null;
  toNode: SdkNode;
}

interface SdkDataFlowEdge {
  sourceNode: SdkNode;
  sourceOutput: string;
  destinationNode: SdkNode;
  destinationInput: string;
}

const BUILTIN_NODE_TYPES = new Set([
  'StartNode',
  'EndNode',
  'AgentNode',
  'ToolNode',
  'LlmNode',
  'BranchingNode',
]);

export interface AdapterOptions {
  registry?: PluginRegistry;
}

export function toSpecFlow(
  sdkComponent: ComponentBase,
  options: AdapterOptions = {},
): ParsedFlow {
  const flow = sdkComponent as unknown as SdkFlow;
  if (flow.componentType !== 'Flow') {
    throw new SpecError(
      `expected componentType 'Flow', got "${flow.componentType}"`,
    );
  }

  const parsedNodes = flow.nodes.map((node) => toSpecNode(node, options));

  return {
    name: flow.name,
    componentType: 'Flow',
    startNode: flow.startNode,
    nodes: parsedNodes,
    controlFlowConnections: flow.controlFlowConnections.map(toControlFlowEdge),
    dataFlowConnections: (flow.dataFlowConnections ?? []).map(toDataFlowEdge),
    parsedNodes,
  };
}

function toControlFlowEdge(edge: SdkControlFlowEdge): ControlFlowEdge {
  return {
    fromNode: edge.fromNode.name,
    fromBranch: edge.fromBranch ?? undefined,
    toNode: edge.toNode.name,
  };
}

function toDataFlowEdge(edge: SdkDataFlowEdge): DataFlowEdge {
  return {
    sourceNode: edge.sourceNode.name,
    sourceOutput: edge.sourceOutput,
    destinationNode: edge.destinationNode.name,
    destinationInput: edge.destinationInput,
  };
}

function toSpecNode(node: SdkNode, options: AdapterOptions): AnyNode {
  const registry = options.registry;

  if (BUILTIN_NODE_TYPES.has(node.componentType)) {
    return node as unknown as AnyNode;
  }
  if (registry?.nodeDef(node.componentType)) {
    return node as unknown as AnyNode;
  }

  const kind = registry?.kindOf(node.componentType);
  throw new SpecError(
    kind
      ? wrongKindMessage(node, kind)
      : unknownNodeTypeMessage(node, registry),
  );
}

function wrongKindMessage(node: SdkNode, kind: string): string {
  const hint =
    kind === 'transform' ? ' — it goes on an agent\'s "transforms"' : '';
  return (
    `node "${node.name}" has type "${node.componentType}", which a plugin ` +
    `provides as a ${kind} rather than a node. A ${kind} is not written into ` +
    `"nodes"${hint}.`
  );
}

function unknownNodeTypeMessage(
  node: SdkNode,
  registry: PluginRegistry | undefined,
): string {
  const known = [
    ...BUILTIN_NODE_TYPES,
    ...(registry?.componentTypeNames() ?? []),
  ];
  return (
    `node "${node.name}" has type "${node.componentType}", which no builtin or ` +
    `plugin provides.\n  Known node types: ${known.join(', ')}\n` +
    `  Loaded plugins: ${registry?.describe() ?? 'none'}\n` +
    `  Add a plugin with --plugin <module> if this type comes from one.`
  );
}
