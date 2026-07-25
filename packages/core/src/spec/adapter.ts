/**
 * Adapter module that bridges the agentspec SDK's object-graph types
 * to specrun's internal representation with string-based edge references.
 */
import type { ComponentBase } from 'agentspec';
import type { ParsedFlow, SpecNode, ControlFlowEdge, DataFlowEdge } from './types.js';
import { SpecError } from '../errors.js';

/** SDK Flow type (we use structural typing to avoid tight coupling). */
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
  // AgentNode
  agent?: unknown;
  // BranchingNode
  mapping?: Record<string, string>;
  // LlmNode
  promptTemplate?: string;
  llmConfig?: unknown;
  // ToolNode
  tool?: unknown;
  // EndNode
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

const SUPPORTED_NODE_TYPES = new Set([
  'StartNode',
  'EndNode',
  'AgentNode',
  'ToolNode',
  'LlmNode',
  'BranchingNode',
]);

/**
 * Converts an SDK Flow (with object-based edges) to specrun's ParsedFlow
 * (with string-name edges and a flat parsedNodes array).
 */
export function toSpecFlow(sdkComponent: ComponentBase): ParsedFlow {
  const flow = sdkComponent as unknown as SdkFlow;
  if (flow.componentType !== 'Flow') {
    throw new SpecError(
      `expected componentType 'Flow', got "${flow.componentType}"`,
    );
  }

  const parsedNodes = flow.nodes.map(toSpecNode);

  const controlFlowConnections = flow.controlFlowConnections.map(
    (edge): ControlFlowEdge => ({
      fromNode: edge.fromNode.name,
      fromBranch: edge.fromBranch ?? undefined,
      toNode: edge.toNode.name,
    }),
  );

  const dataFlowConnections =
    flow.dataFlowConnections?.map(
      (edge): DataFlowEdge => ({
        sourceNode: edge.sourceNode.name,
        sourceOutput: edge.sourceOutput,
        destinationNode: edge.destinationNode.name,
        destinationInput: edge.destinationInput,
      }),
    ) ?? [];

  return {
    name: flow.name,
    componentType: 'Flow',
    startNode: flow.startNode,
    nodes: flow.nodes,
    controlFlowConnections,
    dataFlowConnections,
    parsedNodes,
  };
}

/** Converts an SDK node to specrun's SpecNode type. */
function toSpecNode(node: SdkNode): SpecNode {
  if (!SUPPORTED_NODE_TYPES.has(node.componentType)) {
    throw new SpecError(
      `specrun does not yet support ${node.componentType} execution. ` +
        `Supported: ${[...SUPPORTED_NODE_TYPES].join(', ')}`,
    );
  }
  // The SDK node objects are already the right shape for specrun's SpecNode union
  // since we're using structural typing. We just need to cast appropriately.
  return node as unknown as SpecNode;
}
