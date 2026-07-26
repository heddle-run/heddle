/**
 * Core type definitions for heddle.
 *
 * Uses agentspec SDK types for components, with heddle-specific types
 * for the graph representation (string-based edge references).
 */
import type { ComponentBase, Property } from 'agentspec';
import type { JsonSchema } from '../llm/types.js';

// Re-export SDK Property type
export type { Property } from 'agentspec';

/** Returns the "title" field from a Property. */
export function propertyTitle(p: Property): string {
  return p.title ?? '';
}

/** LLMConfig holds LLM provider configuration. */
export interface LLMConfig {
  componentType?: string;
  modelId: string;
  url?: string;
  apiKey?: string;
  defaultGenerationParameters?: JsonSchema;
}

/** ToolSpec defines a tool in Agent Spec. */
export interface ToolSpec {
  componentType: string;
  name: string;
  description?: string;
  inputs?: Property[];
  outputs?: Property[];
}

/** Agent represents an Agent Spec Agent component. */
export interface Agent {
  componentType: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  llmConfig?: LLMConfig;
  tools?: ToolSpec[];
  inputs?: Property[];
  outputs?: Property[];
  humanInTheLoop?: boolean;
  /**
   * Message transforms attached to the agent. Agent Spec ships two
   * summarization transforms; plugins contribute the rest.
   */
  transforms?: TransformSpec[];
}

/** A MessageTransform attached to an Agent. */
export interface TransformSpec {
  componentType: string;
  name: string;
  id?: string;
}

/** ControlFlowEdge uses string node names for graph traversal. */
export interface ControlFlowEdge {
  fromNode: string;
  fromBranch?: string;
  toNode: string;
}

/** DataFlowEdge uses string node names for graph traversal. */
export interface DataFlowEdge {
  sourceNode: string;
  sourceOutput: string;
  destinationNode: string;
  destinationInput: string;
}

/** StartNode is the entry point of a flow. */
export interface StartNode {
  componentType: 'StartNode';
  name: string;
  inputs?: Property[];
  outputs?: Property[];
}

/** EndNode is the exit point of a flow. */
export interface EndNode {
  componentType: 'EndNode';
  name: string;
  branchName?: string;
  inputs?: Property[];
  outputs?: Property[];
}

/** AgentNode wraps an Agent within a flow. */
export interface AgentNode {
  componentType: 'AgentNode';
  name: string;
  agent?: Agent;
  inputs?: Property[];
  outputs?: Property[];
}

/** ToolNode executes a tool within a flow. */
export interface ToolNode {
  componentType: 'ToolNode';
  name: string;
  tool?: ToolSpec;
  inputs?: Property[];
  outputs?: Property[];
}

/** LLMNode runs a prompt template through an LLM. */
export interface LLMNode {
  componentType: 'LlmNode';
  name: string;
  llmConfig?: LLMConfig;
  promptTemplate: string;
  inputs?: Property[];
  outputs?: Property[];
}

/** BranchingNode routes execution based on a mapping. */
export interface BranchingNode {
  componentType: 'BranchingNode';
  name: string;
  mapping: Record<string, string>;
  inputs?: Property[];
}

/** SpecNode is a discriminated union of all builtin node types. */
export type SpecNode =
  | StartNode
  | EndNode
  | AgentNode
  | ToolNode
  | LLMNode
  | BranchingNode;

/**
 * CustomNode is a node contributed by a plugin. Its own fields are not known
 * statically, so plugin code reads them from the node it is handed.
 */
export interface CustomNode {
  componentType: string;
  name: string;
  inputs?: Property[];
  outputs?: Property[];
  branches?: string[];
}

/** AnyNode is any node a compiled flow may contain, builtin or plugin-provided. */
export type AnyNode = SpecNode | CustomNode;

/** Flow represents the raw flow structure. */
export interface Flow {
  name: string;
  componentType: string;
  startNode: unknown;
  nodes: unknown[];
  controlFlowConnections: ControlFlowEdge[];
  dataFlowConnections?: DataFlowEdge[];
}

/** ParsedFlow holds the fully parsed flow with resolved nodes. */
export interface ParsedFlow extends Flow {
  parsedNodes: AnyNode[];
}

/** Collect all ServerTool names from a parsed flow. */
export function collectToolNames(pf: ParsedFlow): string[] {
  const seen = new Set<string>();

  for (const n of pf.parsedNodes) {
    let tools: ToolSpec[] | undefined;
    if (n.componentType === 'AgentNode') {
      tools = (n as AgentNode).agent?.tools;
    } else if (n.componentType === 'ToolNode') {
      const tool = (n as ToolNode).tool;
      if (tool?.componentType === 'ServerTool') tools = [tool];
    }

    if (tools) {
      for (const t of tools) {
        if (t.componentType === 'ServerTool') seen.add(t.name);
      }
    }
  }

  return [...seen];
}
