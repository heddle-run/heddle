import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  inputFormatByName,
  loadFlow,
  messageOf,
  parseFlowObject,
  parseFlowWith,
  validateFlow,
  type ParsedFlow,
  type PluginRegistry,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';

export interface FlowRequest {
  flow?: unknown;
  flowPath?: string;
  /**
   * The input format of a string "flow" or of the file behind "flowPath", by
   * name. Defaults to YAML for a string body — YAML 1.2 reads JSON too, which
   * is how an untagged body has always been read — and to the file's extension
   * for a path. The names on offer are `formats` in /capabilities.
   */
  format?: string;
}

export function resolveFlow(
  body: FlowRequest,
  config: ServerConfig,
  plugins?: PluginRegistry,
): ParsedFlow {
  const inline = body.flow !== undefined && body.flow !== null;
  const path = typeof body.flowPath === 'string' && body.flowPath.length > 0;

  if (inline && path) {
    throw new HttpError(400, 'provide either "flow" or "flowPath", not both');
  }
  if (!inline && !path) {
    throw new HttpError(400, 'request must provide "flow" or "flowPath"');
  }
  if (body.format !== undefined && typeof body.format !== 'string') {
    throw new HttpError(400, '"format" must be a string naming an input format');
  }

  return path
    ? flowFromPath(body.flowPath as string, body.format, config, plugins)
    : flowFromBody(body.flow, body.format, plugins);
}

export function resolveFlowPath(flowsRoot: string, requested: string): string {
  let root: string;
  try {
    root = realpathSync(flowsRoot);
  } catch {
    throw new HttpError(
      500,
      `flowsRoot "${flowsRoot}" is not accessible`,
      'ConfigError',
    );
  }

  let real: string;
  try {
    real = realpathSync(resolve(root, requested));
  } catch {
    throw notFound(requested);
  }

  if (real !== root && !real.startsWith(root + sep)) {
    throw notFound(requested);
  }

  return real;
}

function flowFromPath(
  requested: string,
  format: string | undefined,
  config: ServerConfig,
  plugins?: PluginRegistry,
): ParsedFlow {
  if (!config.flowsRoot) {
    throw new HttpError(
      400,
      '"flowPath" is not accepted: this server was started without a flows root. Submit the flow inline via "flow".',
    );
  }

  const path = resolveFlowPath(config.flowsRoot, requested);
  return specErrorAsBadRequest(() => loadFlow(path, plugins, { format }));
}

function flowFromBody(
  flow: unknown,
  format: string | undefined,
  plugins?: PluginRegistry,
): ParsedFlow {
  // An object body has no wire format left to choose — the transport already
  // parsed it — so a "format" beside one is a request that cannot mean
  // anything, refused rather than ignored.
  if (typeof flow !== 'string' && format !== undefined) {
    throw new HttpError(
      400,
      '"format" applies to a "flow" sent as a string (or a "flowPath"); ' +
        'an inline flow object is already parsed',
    );
  }

  return specErrorAsBadRequest(() => {
    const parsed =
      typeof flow === 'string'
        ? parseFlowWith(inputFormatByName(format ?? 'yaml', plugins), flow, plugins)
        : parseFlowObject(flow, plugins);

    validateFlow(parsed);
    return parsed;
  });
}

function specErrorAsBadRequest(parse: () => ParsedFlow): ParsedFlow {
  try {
    return parse();
  } catch (err) {
    if (err instanceof HttpError) throw err;

    const message = messageOf(err);
    if (err instanceof TypeError) {
      throw new HttpError(400, unparseableFlowMessage(message), 'SpecError');
    }

    const type =
      err instanceof Error && err.name !== 'Error' ? err.name : 'SpecError';
    throw new HttpError(400, message, type);
  }
}

function notFound(requested: string): HttpError {
  return new HttpError(
    404,
    `flow "${requested}" not found under the configured flows root`,
    'NotFound',
  );
}

function unparseableFlowMessage(parserMessage: string): string {
  return (
    'this does not parse as an Agent Spec flow. Check that it declares ' +
    'component_type, name, start_node, nodes and control_flow_connections. ' +
    `(the parser failed with: ${parserMessage})`
  );
}
