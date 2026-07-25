import type { Agent, ParsedFlow } from './types.js';
import { SpecError } from '../errors.js';

/**
 * ValidateFlow checks a ParsedFlow for spec-level validity.
 *
 * Most structural validation (required fields, correct types) is handled
 * by the agentspec SDK's Zod schemas during deserialization. This function
 * checks additional graph-level constraints.
 */
export function validateFlow(pf: ParsedFlow): void {
  const errs: string[] = [];

  if (!pf.name) {
    errs.push('flow name is required');
  }

  if (pf.parsedNodes.length === 0) {
    errs.push('flow must have at least one node');
  }

  // Check for duplicate node names
  const nodeNames = new Map<string, number>();
  for (const n of pf.parsedNodes) {
    const name = n.name;
    const count = (nodeNames.get(name) ?? 0) + 1;
    nodeNames.set(name, count);
    if (count > 1) {
      errs.push(`duplicate node name "${name}"`);
    }
  }

  // Validate control flow edges reference valid nodes
  for (let i = 0; i < pf.controlFlowConnections.length; i++) {
    const edge = pf.controlFlowConnections[i];
    if (!nodeNames.has(edge.fromNode)) {
      errs.push(
        `controlFlowConnections[${i}]: fromNode "${edge.fromNode}" not found`,
      );
    }
    if (!nodeNames.has(edge.toNode)) {
      errs.push(
        `controlFlowConnections[${i}]: toNode "${edge.toNode}" not found`,
      );
    }
  }

  // Validate data flow edges reference valid nodes
  const dataEdges = pf.dataFlowConnections ?? [];
  for (let i = 0; i < dataEdges.length; i++) {
    const edge = dataEdges[i];
    if (!nodeNames.has(edge.sourceNode)) {
      errs.push(
        `dataFlowConnections[${i}]: sourceNode "${edge.sourceNode}" not found`,
      );
    }
    if (!nodeNames.has(edge.destinationNode)) {
      errs.push(
        `dataFlowConnections[${i}]: destinationNode "${edge.destinationNode}" not found`,
      );
    }
  }

  if (errs.length > 0) {
    throw new SpecError(errs.join('; '));
  }
}

/** ValidateAgent checks an Agent for spec-level validity. */
export function validateAgent(agent: Agent): void {
  const errs: string[] = [];

  if (!agent.name) {
    errs.push('agent name is required');
  }
  if (agent.componentType !== 'Agent') {
    errs.push(
      `expected componentType 'Agent', got "${agent.componentType}"`,
    );
  }

  if (errs.length > 0) {
    throw new SpecError(errs.join('; '));
  }
}
