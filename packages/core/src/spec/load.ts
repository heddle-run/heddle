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

/**
 * Read a flow document from disk, parse it, and check it holds together.
 *
 * The format comes from the extension — `.yaml`/`.yml` is YAML, anything else
 * is JSON — and what comes back has already passed {@link validateFlow}, so a
 * loaded flow is one whose edges all name nodes it has. Pass the registry when
 * the document uses plugin-provided component types; without it, those fail to
 * parse as unknown types. What this does *not* check is anything that needs
 * the compiled graph — reachability, dead branches — which is `validate`'s
 * half, after `compile`.
 */
export function loadFlow(
  flowPath: string,
  registry?: PluginRegistry,
): ParsedFlow {
  const data = readFileSync(flowPath, 'utf-8');
  const flow = isYaml(flowPath)
    ? parseFlowYaml(data, registry)
    : parseFlow(data, registry);

  validateFlow(flow);
  return flow;
}

/**
 * `loadFlow` for a file whose top-level component could be anything — an
 * Agent, a Flow, a bare config. It answers "what is in this file" rather than
 * "give me something runnable", so unlike {@link loadFlow} it validates
 * nothing beyond the parse; a caller wanting a runnable flow uses `loadFlow`.
 */
export function loadComponent(
  filePath: string,
  registry?: PluginRegistry,
): ComponentBase {
  const data = readFileSync(filePath, 'utf-8');
  return isYaml(filePath)
    ? parseComponentYaml(data, registry)
    : parseComponentJson(data, registry);
}

function isYaml(path: string): boolean {
  return path.endsWith('.yaml') || path.endsWith('.yml');
}
