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
import type { PluginRegistry } from '../plugin/registry.js';

function isYaml(path: string): boolean {
  return path.endsWith('.yaml') || path.endsWith('.yml');
}

/** Load and validate a flow file (JSON or YAML detected by extension). */
export function loadFlow(
  flowPath: string,
  registry?: PluginRegistry,
): ParsedFlow {
  const data = readFileSync(flowPath, 'utf-8');
  const pf = isYaml(flowPath)
    ? parseFlowYaml(data, registry)
    : parseFlow(data, registry);

  validateFlow(pf);
  return pf;
}

/** Load any agent-spec component (Flow, Agent, Swarm, etc.) via SDK deserialization. */
export function loadComponent(
  filePath: string,
  registry?: PluginRegistry,
): ComponentBase {
  const data = readFileSync(filePath, 'utf-8');
  return isYaml(filePath)
    ? parseComponentYaml(data, registry)
    : parseComponentJson(data, registry);
}
