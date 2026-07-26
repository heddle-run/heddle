import type { ServerResponse } from 'node:http';
import { FileRegistry } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { sendJson } from './http.js';
import type { ConcurrencyGate } from './limits.js';

/**
 * GET /v1/capabilities — what this server permits, so a client can adapt.
 *
 * The playground needs this to know whether to offer the tools and plugins
 * editors at all, and what limits to enforce in the browser rather than
 * discovering through 400s.
 *
 * Deliberately free of filesystem paths. Tool *names* are useful to a caller
 * writing a flow; the directory they live in is not, and telling an
 * unauthenticated caller where the server keeps its executables gives away
 * something for nothing.
 */
export function handleCapabilities(
  res: ServerResponse,
  config: ServerConfig,
  gate: ConcurrencyGate,
  version: string,
  headers: Record<string, string> = {},
): void {
  let serverTools: string[] = [];
  if (config.toolsDir) {
    try {
      serverTools = FileRegistry.create(config.toolsDir)
        .all()
        .map((tool) => tool.name)
        .sort();
    } catch {
      // An unreadable tools directory is an operational problem, not a reason
      // to fail a capabilities probe. Runs naming a tool will still 400.
      serverTools = [];
    }
  }

  sendJson(
    res,
    200,
    {
      version,
      allowRequestCode: config.allowRequestCode,
      acceptsFlowPath: Boolean(config.flowsRoot),
      sandbox: config.sandbox?.name ?? null,
      tools: serverTools,
      limits: {
        maxIterations: config.maxIterations,
        timeout: config.timeout,
        maxBodyBytes: config.maxBodyBytes,
        maxRequestTools: config.maxRequestTools,
        maxRequestPlugins: config.maxRequestPlugins,
        maxRequestCodeBytes: config.maxRequestCodeBytes,
        maxConcurrentRuns: config.maxConcurrentRuns,
      },
      runsInFlight: gate.inFlight,
    },
    headers,
  );
}
