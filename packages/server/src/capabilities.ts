import type { ServerResponse } from 'node:http';
import { BUILTIN_PROTOCOL, EVENT_CONTRACT_VERSION, FileRegistry } from '@heddle/core';
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
      /**
       * The renderings a request may ask for with `?protocol=`.
       *
       * Only heddle's own, and it is a list of one rather than a boolean because
       * that is the honest shape: an encoder arrives with a request, so what this
       * server can render depends on what the caller sends, and no probe made
       * beforehand can enumerate it. What this says is "heddle's frames always
       * work, and anything else is yours to submit" — which, when
       * `allowRequestCode` is false, is the whole answer.
       */
      protocols: [BUILTIN_PROTOCOL],
      eventContract: EVENT_CONTRACT_VERSION,
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
      // The same number Prometheus scrapes from /metrics. Kept here so a client
      // can back off before it is refused, without a metrics endpoint.
      runSaturation: config.maxConcurrentRuns > 0
        ? gate.inFlight / config.maxConcurrentRuns
        : 0,
    },
    headers,
  );
}
