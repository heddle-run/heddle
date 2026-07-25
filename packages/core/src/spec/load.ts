import { readFileSync } from 'node:fs';
import type { ComponentBase } from 'agentspec';
import {
  parseFlow,
  parseFlowYaml,
  parseComponentYaml,
  parseComponentJson,
} from './parser.js';
import { validateFlow } from './validate.js';
import type { ParsedFlow } from './types.js';

function isYaml(path: string): boolean {
  return path.endsWith('.yaml') || path.endsWith('.yml');
}

/** Load and validate a flow file (JSON or YAML detected by extension). */
export function loadFlow(flowPath: string): ParsedFlow {
  const data = readFileSync(flowPath, 'utf-8');
  const pf = isYaml(flowPath) ? parseFlowYaml(data) : parseFlow(data);

  validateFlow(pf);
  return pf;
}

/** Load any agent-spec component (Flow, Agent, Swarm, etc.) via SDK deserialization. */
export function loadComponent(filePath: string): ComponentBase {
  const data = readFileSync(filePath, 'utf-8');
  return isYaml(filePath)
    ? parseComponentYaml(data)
    : parseComponentJson(data);
}
