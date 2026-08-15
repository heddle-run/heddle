/**
 * The public parsing surface: text or a parsed value in, a validated
 * {@link ParsedFlow} out.
 *
 * Two passes behind one call — `parseWeave` for the document's own shape,
 * `resolveFlow` for everything that needs the graph or the loaded plugins.
 * The registry is how a document naming plugin component types validates;
 * without it they are unknown types.
 */

import { parseWeave } from './parse.js';
import { resolveFlow } from './resolve.js';
import type { ParsedFlow } from './types.js';
import { PluginRegistry } from '../plugin/registry.js';
import {
  JSON_INPUT_FORMAT,
  YAML_INPUT_FORMAT,
  type InputFormatDef,
} from './input-format.js';
import { SpecError } from '../errors.js';

const NO_PLUGINS = PluginRegistry.empty();

/**
 * `parseFlow` through any input format — the seam every entry point below is
 * a fixed-format wrapper over. The format turns text into a Weave document;
 * everything after that is one shared pipeline.
 */
export function parseFlowWith(
  format: InputFormatDef,
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  const text = typeof data === 'string' ? data : data.toString();

  let value: unknown;
  try {
    value = format.parse(text);
  } catch (err) {
    throw new SpecError(
      `this does not parse as ${format.name.toUpperCase()}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  return parseFlowObject(value, registry);
}

/** Parse a JSON Weave document. */
export function parseFlow(
  data: string | Buffer,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return parseFlowWith(JSON_INPUT_FORMAT, data, registry);
}

/** {@link parseFlow} for a YAML document. */
export function parseFlowYaml(
  data: string,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  return parseFlowWith(YAML_INPUT_FORMAT, data, registry);
}

/**
 * `parseFlow` for a document that is already a parsed value.
 *
 * What a server holding a request body wants: the body arrived as JSON and was
 * parsed once by the transport, so serializing it again just to parse it back
 * is a round trip that proves nothing.
 */
export function parseFlowObject(
  raw: unknown,
  registry: PluginRegistry = NO_PLUGINS,
): ParsedFlow {
  const flow = parseWeave(raw);
  resolveFlow(flow, registry);
  return flow;
}
