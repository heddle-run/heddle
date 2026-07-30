import type { Property } from 'agentspec';
import type { JsonSchema } from '../llm/types.js';

export type { Property } from 'agentspec';

export function propertyTitle(property: Property): string {
  return property.title ?? '';
}

export interface LLMConfig {
  componentType?: string;
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

export interface StartNode {
  componentType: 'StartNode';
  name: string;
  inputs?: Property[];
  outputs?: Property[];
}

export interface EndNode {
  componentType: 'EndNode';
  name: string;
  branchName?: string;
  inputs?: Property[];
  outputs?: Property[];
}

export interface AgentNode {
  componentType: 'AgentNode';
  name: string;
  agent?: Agent;
  inputs?: Property[];
  outputs?: Property[];
}

export interface ToolNode {
  componentType: 'ToolNode';
  name: string;
  tool?: ToolSpec;
  inputs?: Property[];
  outputs?: Property[];
}

export interface LLMNode {
  componentType: 'LlmNode';
  name: string;
  llmConfig?: LLMConfig;
  promptTemplate: string;
  inputs?: Property[];
  outputs?: Property[];
}

export interface BranchingNode {
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

export interface CustomNode {
  componentType: string;
  name: string;
  inputs?: Property[];
  outputs?: Property[];
  branches?: string[];
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
