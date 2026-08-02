import { readFileSync } from 'node:fs';
import type { ComponentBase } from 'agentspec';
import { parseFlowWith, parseComponentWith } from './parser.js';
import { validateFlow } from './validate.js';
import type { ParsedFlow } from './types.js';
import {
  inputFormatByName,
  inputFormatForPath,
  type InputFormatDef,
} from './input-format.js';
import type { PluginRegistry } from '../plugin/registry.js';

export interface LoadOptions {
  /**
   * The input format to read the file with, by name, instead of resolving it
   * from the extension. What `--format` carries.
   */
  format?: string;
}

/**
 * Read a flow document from disk, parse it, and check it holds together.
 *
 * The format comes from the extension unless `options.format` names one —
 * `.yaml`/`.yml` is YAML, an extension a plugin's format claims is that
 * format, anything else is JSON — and what comes back has already passed
 * {@link validateFlow}, so a loaded flow is one whose edges all name nodes it
 * has. Pass the registry when the document uses plugin-provided component
 * types; without it, those fail to parse as unknown types. What this does
 * *not* check is anything that needs the compiled graph — reachability, dead
 * branches — which is `validate`'s half, after `compile`.
 */
export function loadFlow(
  flowPath: string,
  registry?: PluginRegistry,
  options?: LoadOptions,
): ParsedFlow {
  const data = readFileSync(flowPath, 'utf-8');
  const flow = parseFlowWith(formatFor(flowPath, registry, options), data, registry);

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
  options?: LoadOptions,
): ComponentBase {
  const data = readFileSync(filePath, 'utf-8');
  return parseComponentWith(formatFor(filePath, registry, options), data, registry);
}

function formatFor(
  path: string,
  registry?: PluginRegistry,
  options?: LoadOptions,
): InputFormatDef {
  return options?.format !== undefined
    ? inputFormatByName(options.format, registry)
    : inputFormatForPath(path, registry);
}
