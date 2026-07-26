/**
 * Adapter module that bridges the agentspec SDK's object-graph types
 * to heddle's internal representation with string-based edge references.
 */
import type { ComponentBase } from 'agentspec';
import type { AnyNode, ParsedFlow, ControlFlowEdge, DataFlowEdge } from './types.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { PluginComponent, PluginNode } from '../plugin/types.js';
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

/** Optional plugin context used when the flow contains custom node types. */
export interface AdapterOptions {
  registry?: PluginRegistry;
  /** Real plugin nodes keyed by id, to swap in for their stand-ins. */
  pluginNodes?: Map<string, PluginNode>;
  /** Real plugin transforms keyed by id, to swap in for their stand-ins. */
  pluginTransforms?: Map<string, PluginComponent>;
}

/**
 * Converts an SDK Flow (with object-based edges) to heddle's ParsedFlow
 * (with string-name edges and a flat parsedNodes array).
 */
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

  const parsedNodes = flow.nodes.map((n) => toSpecNode(n, options));

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
    nodes: parsedNodes,
    controlFlowConnections,
    dataFlowConnections,
    parsedNodes,
  };
}

/**
 * Swaps stand-in transforms on an AgentNode's agent back for the real plugin
 * components. Returns undefined when there is nothing to restore, so the common
 * path allocates nothing.
 *
 * The SDK freezes the components it builds, so the agent is rebuilt rather than
 * mutated.
 */
function restoreTransforms(
  node: SdkNode,
  options: AdapterOptions,
): SdkNode | undefined {
  const byId = options.pluginTransforms;
  if (!byId || byId.size === 0 || node.componentType !== 'AgentNode') {
    return undefined;
  }

  const agent = node.agent as
    | { transforms?: Array<{ id?: string }> }
    | undefined;
  const transforms = agent?.transforms;
  if (!Array.isArray(transforms) || transforms.length === 0) {
    return undefined;
  }
  if (!transforms.some((t) => t?.id && byId.has(t.id))) {
    return undefined;
  }

  return {
    ...node,
    agent: {
      ...agent,
      transforms: transforms.map((t) =>
        t?.id && byId.has(t.id) ? byId.get(t.id)! : t,
      ),
    },
  };
}

/** Converts an SDK node to heddle's node representation. */
function toSpecNode(node: SdkNode, options: AdapterOptions): AnyNode {
  // A stand-in inserted so the SDK's Flow schema would accept a plugin node;
  // the real component is restored here. See plugin/flow-preprocess.ts.
  const real = node.id ? options.pluginNodes?.get(node.id) : undefined;
  if (real) {
    return real as unknown as AnyNode;
  }

  const restored = restoreTransforms(node, options);
  if (restored) {
    return restored as unknown as AnyNode;
  }

  if (!SUPPORTED_NODE_TYPES.has(node.componentType)) {
    const known = [
      ...SUPPORTED_NODE_TYPES,
      ...(options.registry?.nodeTypeNames() ?? []),
    ];
    throw new SpecError(
      `node "${node.name}" has type "${node.componentType}", which no builtin or ` +
        `plugin provides.\n  Known node types: ${known.join(', ')}\n` +
        `  Loaded plugins: ${options.registry?.describe() ?? 'none'}\n` +
        `  Add a plugin with --plugin <module> if this type comes from one.`,
    );
  }
  // The SDK node objects are already the right shape for heddle's SpecNode union
  // since we're using structural typing. We just need to cast appropriately.
  return node as unknown as AnyNode;
}
