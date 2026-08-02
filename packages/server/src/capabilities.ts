import type { ServerResponse } from 'node:http';
import { BUILTIN_PROTOCOL, EVENT_CONTRACT_VERSION } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { sendJson } from './http.js';
import type { ConcurrencyGate } from './limits.js';

export function handleCapabilities(
  res: ServerResponse,
  config: ServerConfig,
  gate: ConcurrencyGate,
  version: string,
  headers: Record<string, string> = {},
): void {
  sendJson(
    res,
    200,
    {
      version,
      allowRequestCode: config.allowRequestCode,
      acceptsFlowPath: Boolean(config.flowsRoot),
      sandbox: config.sandbox?.name ?? null,
      tools: serverToolNames(config),
      protocols: [BUILTIN_PROTOCOL, ...(config.plugins?.encoderProtocols() ?? [])],
      // What is installed and will run whether or not a caller asked for it.
      // A caller cannot select middleware, but it can reject their tool call or
      // end their run, and the name they would see in that error is this one.
      middleware: installedMiddleware(config),
      // Whether a caller can hold a conversation here at all, said before they
      // try. Sessions are off unless the operator turned them on, so without
      // this the only way to find out is a 400 on a run somebody meant.
      sessions: {
        enabled: Boolean(config.sessionStore),
        store: config.sessionStoreName ?? null,
      },
      eventContract: EVENT_CONTRACT_VERSION,
      limits: {
        maxIterations: config.maxIterations,
        timeout: config.timeout,
        maxBodyBytes: config.maxBodyBytes,
        maxRequestTools: config.maxRequestTools,
        maxRequestPlugins: config.maxRequestPlugins,
        maxRequestFiles: config.maxRequestFiles,
        maxRequestCodeBytes: config.maxRequestCodeBytes,
        maxConcurrentRuns: config.maxConcurrentRuns,
      },
      runsInFlight: gate.inFlight,
      runSaturation:
        config.maxConcurrentRuns > 0
          ? gate.inFlight / config.maxConcurrentRuns
          : 0,
    },
    headers,
  );
}

function installedMiddleware(config: ServerConfig): string[] {
  return (config.plugins?.middlewareDefs() ?? [])
    .map(({ def }) => def.componentType)
    .sort();
}

/**
 * Every tool a flow can name without bringing one.
 *
 * The directory and the installed plugins, which is what a run resolves against
 * before it adds anything the request submitted.
 */
function serverToolNames(config: ServerConfig): string[] {
  const fromPlugins = (config.plugins?.toolRegistry().all() ?? []).map(
    (tool) => tool.name,
  );

  return [...fromDirectory(config), ...fromPlugins].sort();
}

function fromDirectory(config: ServerConfig): string[] {
  if (!config.toolsDir) return [];

  try {
    return config
      .toolsRegistry()
      .all()
      .map((tool) => tool.name);
  } catch {
    return [];
  }
}
