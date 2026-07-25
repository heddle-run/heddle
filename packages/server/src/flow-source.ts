import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  loadFlow,
  parseFlow,
  parseFlowYaml,
  validateFlow,
  type ParsedFlow,
} from '@heddle/core';
import type { ServerConfig } from './config.js';
import { HttpError } from './errors.js';

/** The flow-selecting fields shared by every request body. */
export interface FlowRequest {
  /** An inline spec: either a JSON object, or JSON/YAML source text. */
  flow?: unknown;
  /** A path relative to the configured `flowsRoot`. */
  flowPath?: string;
}

/**
 * Resolve `flowPath` against the configured root, refusing anything that
 * escapes it.
 *
 * Both the root and the candidate are passed through `realpath`, so a symlink
 * inside the root that points outside it is rejected too — comparing
 * lexically-resolved paths alone would not catch that.
 */
export function resolveFlowPath(flowsRoot: string, requested: string): string {
  let root: string;
  try {
    root = realpathSync(flowsRoot);
  } catch {
    throw new HttpError(500, `flowsRoot "${flowsRoot}" is not accessible`, 'ConfigError');
  }

  let real: string;
  try {
    real = realpathSync(resolve(root, requested));
  } catch {
    // Do not distinguish "missing" from "outside the root": that difference
    // would let a caller probe the filesystem outside flowsRoot.
    throw new HttpError(404, `flow "${requested}" not found under the configured flows root`, 'NotFound');
  }

  if (real !== root && !real.startsWith(root + sep)) {
    throw new HttpError(404, `flow "${requested}" not found under the configured flows root`, 'NotFound');
  }

  return real;
}

/** Parse the flow named by a request body, honouring the server's confinement rules. */
export function resolveFlow(body: FlowRequest, config: ServerConfig): ParsedFlow {
  const hasInline = body.flow !== undefined && body.flow !== null;
  const hasPath = typeof body.flowPath === 'string' && body.flowPath.length > 0;

  if (hasInline && hasPath) {
    throw new HttpError(400, 'provide either "flow" or "flowPath", not both');
  }
  if (!hasInline && !hasPath) {
    throw new HttpError(400, 'request must provide "flow" or "flowPath"');
  }

  if (hasPath) {
    if (!config.flowsRoot) {
      throw new HttpError(
        400,
        '"flowPath" is not accepted: this server was started without a flows root. Submit the flow inline via "flow".',
      );
    }
    const path = resolveFlowPath(config.flowsRoot, body.flowPath!);
    return asBadRequest(() => loadFlow(path));
  }

  return asBadRequest(() => {
    const pf =
      typeof body.flow === 'string'
        ? // YAML 1.2 is a superset of JSON, so this accepts either syntax.
          parseFlowYaml(body.flow)
        : parseFlow(JSON.stringify(body.flow));

    validateFlow(pf);
    return pf;
  });
}

/**
 * Run a parse step, reporting any failure as a 400.
 *
 * The agentspec SDK raises plain `Error`s for malformed specs (for example
 * "A Flow should be composed of exactly one StartNode"), which would otherwise
 * be indistinguishable from an internal fault and reported as a 500. A spec the
 * caller supplied and the parser rejected is the caller's problem.
 */
function asBadRequest(parse: () => ParsedFlow): ParsedFlow {
  try {
    return parse();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const type = err instanceof Error && err.name !== 'Error' ? err.name : 'SpecError';
    throw new HttpError(400, message, type);
  }
}
