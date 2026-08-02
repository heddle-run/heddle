import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  loadFlow,
  messageOf,
  parseFlowObject,
  parseFlowYaml,
  validateFlow,
  type ParsedFlow,
  type PluginRegistry,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';

export interface FlowRequest {
  flow?: unknown;
  flowPath?: string;
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

  return path
    ? flowFromPath(body.flowPath as string, config, plugins)
    : flowFromBody(body.flow, plugins);
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
  return specErrorAsBadRequest(() => loadFlow(path, plugins));
}

function flowFromBody(flow: unknown, plugins?: PluginRegistry): ParsedFlow {
  return specErrorAsBadRequest(() => {
    const parsed =
      typeof flow === 'string'
        ? parseFlowYaml(flow, plugins)
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
