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
