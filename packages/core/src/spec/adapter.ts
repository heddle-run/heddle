/**
 * Adapter module that bridges the agentspec SDK's object-graph types
 * to heddle's internal representation with string-based edge references.
 */
import type { ComponentBase } from 'agentspec';
import type { AnyNode, ParsedFlow, ControlFlowEdge, DataFlowEdge } from './types.js';
import type { PluginRegistry } from '../plugin/registry.js';
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
 * Optional plugin context used when the flow contains custom node types.
 *
 * One field, where there were three. The other two carried the real plugin
 * components keyed by the id of the stand-in that stood for them — the whole
 * cost of a closed union, paid on every parse. The unions are widened now, so
 * the SDK hands back the real component and there is nothing to swap.
 */
export interface AdapterOptions {
  registry?: PluginRegistry;
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
 * Converts an SDK node to heddle's node representation.
 *
 * This guard is the slot discipline the widened union gave up, and it is the
 * reason widening was affordable. `Flow.nodes` no longer refuses a component
 * type it does not know, so a plugin *transform* written where a node belongs
 * now parses — and would reach the compiler as a node with no executor. Here it
 * is refused by kind, naming what the type actually is, which is a better
 * message than the union's `Invalid discriminator value` ever was.
 */
function toSpecNode(node: SdkNode, options: AdapterOptions): AnyNode {
  if (!SUPPORTED_NODE_TYPES.has(node.componentType)) {
    const registry = options.registry;
    // A plugin node is a node. Nothing else a plugin provides is: a transform
    // hangs off an agent, a `component` is nested inside one of those, and a
    // middleware is never named in a document at all.
    if (registry?.nodeDef(node.componentType)) {
      return node as unknown as AnyNode;
    }

    const kind = registry?.kindOf(node.componentType);
    if (kind) {
      throw new SpecError(
        `node "${node.name}" has type "${node.componentType}", which a plugin ` +
          `provides as a ${kind} rather than a node. A ${kind} is not written into ` +
          `"nodes"${kind === 'transform' ? ' — it goes on an agent\'s "transforms"' : ''}.`,
      );
    }

    const known = [
      ...SUPPORTED_NODE_TYPES,
      ...(registry?.componentTypeNames() ?? []),
    ];
    throw new SpecError(
      `node "${node.name}" has type "${node.componentType}", which no builtin or ` +
        `plugin provides.\n  Known node types: ${known.join(', ')}\n` +
        `  Loaded plugins: ${registry?.describe() ?? 'none'}\n` +
        `  Add a plugin with --plugin <module> if this type comes from one.`,
    );
  }
  // The SDK node objects are already the right shape for heddle's SpecNode union
  // since we're using structural typing. We just need to cast appropriately.
  return node as unknown as AnyNode;
}
