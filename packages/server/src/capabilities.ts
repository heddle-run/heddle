import type { ServerResponse } from 'node:http';
import {
  BUILTIN_PROTOCOL,
  EVENT_CONTRACT_VERSION,
  FileRegistry,
} from '@heddle/core';
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
      runSaturation:
        config.maxConcurrentRuns > 0
          ? gate.inFlight / config.maxConcurrentRuns
          : 0,
    },
    headers,
  );
}

function serverToolNames(config: ServerConfig): string[] {
  if (!config.toolsDir) return [];

  try {
    return FileRegistry.create(config.toolsDir)
      .all()
      .map((tool) => tool.name)
      .sort();
  } catch {
    return [];
  }
}
