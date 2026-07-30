import type { Agent, ParsedFlow } from './types.js';
import { SpecError } from '../errors.js';

export function validateFlow(flow: ParsedFlow): void {
  const nodeNames = new Set(flow.parsedNodes.map((node) => node.name));

  const problems = [
    ...missingFlowName(flow),
    ...emptyNodeList(flow),
    ...duplicateNodeNames(flow),
    ...danglingControlFlowEdges(flow, nodeNames),
    ...danglingDataFlowEdges(flow, nodeNames),
  ];

  if (problems.length > 0) {
    throw new SpecError(problems.join('; '));
  }
}

export function validateAgent(agent: Agent): void {
  const problems: string[] = [];

  if (!agent.name) {
    problems.push('agent name is required');
  }
  if (agent.componentType !== 'Agent') {
    problems.push(`expected componentType 'Agent', got "${agent.componentType}"`);
  }

  if (problems.length > 0) {
    throw new SpecError(problems.join('; '));
  }
}

function missingFlowName(flow: ParsedFlow): string[] {
  return flow.name ? [] : ['flow name is required'];
}

function emptyNodeList(flow: ParsedFlow): string[] {
  return flow.parsedNodes.length > 0 ? [] : ['flow must have at least one node'];
}

function duplicateNodeNames(flow: ParsedFlow): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const node of flow.parsedNodes) {
    if (seen.has(node.name)) {
      problems.push(`duplicate node name "${node.name}"`);
    }
    seen.add(node.name);
  }

  return problems;
}

function danglingControlFlowEdges(
  flow: ParsedFlow,
  nodeNames: Set<string>,
): string[] {
  return flow.controlFlowConnections.flatMap((edge, index) => [
    ...danglingReference(
      nodeNames,
      edge.fromNode,
      `controlFlowConnections[${index}]: fromNode`,
    ),
    ...danglingReference(
      nodeNames,
      edge.toNode,
      `controlFlowConnections[${index}]: toNode`,
    ),
  ]);
}

function danglingDataFlowEdges(
  flow: ParsedFlow,
  nodeNames: Set<string>,
): string[] {
  return (flow.dataFlowConnections ?? []).flatMap((edge, index) => [
    ...danglingReference(
      nodeNames,
      edge.sourceNode,
      `dataFlowConnections[${index}]: sourceNode`,
    ),
    ...danglingReference(
      nodeNames,
      edge.destinationNode,
      `dataFlowConnections[${index}]: destinationNode`,
    ),
  ]);
}

function danglingReference(
  nodeNames: Set<string>,
  referenced: string,
  label: string,
): string[] {
  return nodeNames.has(referenced) ? [] : [`${label} "${referenced}" not found`];
}
