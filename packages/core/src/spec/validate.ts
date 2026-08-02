import type { Agent, ParsedFlow } from './types.js';
import { SpecError } from '../errors.js';

/**
 * Check a parsed flow document is internally consistent — named, non-empty, no
 * duplicate node names, no edge referring to a node the flow does not have.
 *
 * The first of heddle's two validation passes, and the one that needs nothing
 * but the document: `loadFlow` runs it for you, so calling it yourself only
 * matters for a flow that arrived some other way. The second pass is graph
 * `validate`, which sees what only the compiled graph can show. Throws a
 * `SpecError` naming every problem at once rather than the first.
 */
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

/**
 * `validateFlow`'s counterpart for a standalone Agent document: a name and the
 * right componentType, which is all that is checkable before the agent is
 * embedded in a flow and compiled.
 */
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
