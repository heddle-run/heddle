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

  const nodeNames = new Set<string>();
  for (const n of pf.parsedNodes) {
    if (nodeNames.has(n.name)) {
      errs.push(`duplicate node name "${n.name}"`);
    }
    nodeNames.add(n.name);
  }

  /** Both edge kinds name two nodes; only the field names differ. */
  const checkEndpoints = <E>(
    field: string,
    edges: E[],
    ends: Array<keyof E & string>,
  ): void => {
    edges.forEach((edge, i) => {
      for (const end of ends) {
        const name = String(edge[end]);
        if (!nodeNames.has(name)) {
          errs.push(`${field}[${i}]: ${end} "${name}" not found`);
        }
      }
    });
  };

  checkEndpoints('controlFlowConnections', pf.controlFlowConnections, [
    'fromNode',
    'toNode',
  ]);
  checkEndpoints('dataFlowConnections', pf.dataFlowConnections ?? [], [
    'sourceNode',
    'destinationNode',
  ]);

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
