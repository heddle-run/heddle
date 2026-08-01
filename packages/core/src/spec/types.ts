import type { Property } from 'agentspec';
import type { JsonSchema } from '../llm/types.js';

export type { Property } from 'agentspec';

export function propertyTitle(property: Property): string {
  return property.title ?? '';
}

export interface LLMConfig {
  componentType?: string;
  /**
   * What the spec called this configuration.
   *
   * Declared because a spec carries one and something reads it: a plugin
   * provider is handed the config as a `PluginComponent`, whose `name` heddle
   * quotes back in every error about that provider. It was absent here for as
   * long as tests went untypechecked, so the cast in `pluginProvider` was
   * carrying a field the type said did not exist.
   */
  name?: string;
  modelId: string;
  url?: string;
  apiKey?: string;
  defaultGenerationParameters?: JsonSchema;
}

export interface ToolSpec {
  componentType: string;
  name: string;
  description?: string;
  inputs?: Property[];
  outputs?: Property[];
}

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
  transforms?: TransformSpec[];
}

export interface TransformSpec {
  componentType: string;
  name: string;
  id?: string;
}

export interface ControlFlowEdge {
  fromNode: string;
  fromBranch?: string;
  toNode: string;
}

export interface DataFlowEdge {
  sourceNode: string;
  sourceOutput: string;
  destinationNode: string;
  destinationInput: string;
}

/**
 * What a node says it can route on.
 *
 * Every node in an Agent Spec document carries this — the SDK's node schema
 * gives it a default of `[]` — and it is the only place a document says which
 * branch labels on a node's outgoing edges are real. `validate` reads it to
 * catch an edge labelled with a branch its source never selects, which a run
 * meets as a node it cannot leave. It was absent from these interfaces for as
 * long as nothing read it.
 */
interface Branched {
  branches?: string[];
}

export interface StartNode extends Branched {
  componentType: 'StartNode';
  name: string;
  inputs?: Property[];
  outputs?: Property[];
}

export interface EndNode extends Branched {
  componentType: 'EndNode';
  name: string;
  branchName?: string;
  inputs?: Property[];
  outputs?: Property[];
}

export interface AgentNode extends Branched {
  componentType: 'AgentNode';
  name: string;
  agent?: Agent;
  inputs?: Property[];
  outputs?: Property[];
}

export interface ToolNode extends Branched {
  componentType: 'ToolNode';
  name: string;
  tool?: ToolSpec;
  inputs?: Property[];
  outputs?: Property[];
}

export interface LLMNode extends Branched {
  componentType: 'LlmNode';
  name: string;
  llmConfig?: LLMConfig;
  promptTemplate: string;
  inputs?: Property[];
  outputs?: Property[];
}

export interface BranchingNode extends Branched {
  componentType: 'BranchingNode';
  name: string;
  mapping: Record<string, string>;
  inputs?: Property[];
}

export type SpecNode =
  | StartNode
  | EndNode
  | AgentNode
  | ToolNode
  | LLMNode
  | BranchingNode;

export interface CustomNode extends Branched {
  componentType: string;
  name: string;
  inputs?: Property[];
  outputs?: Property[];
}

export type AnyNode = SpecNode | CustomNode;

export interface Flow {
  name: string;
  componentType: string;
  startNode: unknown;
  nodes: unknown[];
  controlFlowConnections: ControlFlowEdge[];
  dataFlowConnections?: DataFlowEdge[];
}

export interface ParsedFlow extends Flow {
  parsedNodes: AnyNode[];
}

const SERVER_TOOL = 'ServerTool';

export function collectToolNames(flow: ParsedFlow): string[] {
  const names = new Set<string>();

  for (const node of flow.parsedNodes) {
    for (const tool of toolsOf(node)) {
      if (tool.componentType === SERVER_TOOL) names.add(tool.name);
    }
  }

  return [...names];
}

function toolsOf(node: AnyNode): ToolSpec[] {
  if (node.componentType === 'AgentNode') {
    return (node as AgentNode).agent?.tools ?? [];
  }
  if (node.componentType === 'ToolNode') {
    const tool = (node as ToolNode).tool;
    return tool ? [tool] : [];
  }
  return [];
}
