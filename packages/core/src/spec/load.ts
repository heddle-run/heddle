import { readFileSync } from 'node:fs';
import { parseFlowWith } from './parser.js';
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
 * Read a Weave document from disk, parse it, and check it holds together.
 *
 * The format comes from the extension unless `options.format` names one —
 * `.yaml`/`.yml` is YAML, an extension a plugin's format claims is that
 * format, anything else is JSON. What comes back has passed both passes
 * (`parse` and `resolve`), so a loaded flow is one that compiles: every
 * target lands, every reference has a producer, every plugin type is
 * provided. Pass the registry when the document uses plugin components;
 * without it, those fail as unknown types.
 */
export function loadFlow(
  flowPath: string,
  registry?: PluginRegistry,
  options?: LoadOptions,
): ParsedFlow {
  const data = readFileSync(flowPath, 'utf-8');
  return parseFlowWith(formatFor(flowPath, registry, options), data, registry);
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
