import type { IncomingMessage, ServerResponse } from 'node:http';
import { compile, validate, loadPlugins, PluginRegistry } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { resolveFlow, type FlowRequest } from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';
import {
  materializeRequestCode,
  rejectRequestCode,
  NO_CODE,
  type MaterializedCode,
  type RequestCode,
} from './request-code.js';

/**
 * POST /v1/validate — parse, compile and validate a flow without running it.
 *
 * No tool registry and no executor are supplied, so a validated flow cannot
 * run a tool.
 *
 * Plugins are a different matter, and the difference is worth stating plainly.
 * A flow using a custom `component_type` cannot be parsed without the plugin
 * that defines it, so validating one means loading it — and loading a plugin
 * executes it, both at import and again at compile, where `createExecutor` is
 * called. This endpoint is therefore exactly as privileged as `/v1/runs` when
 * the request carries plugins, and is gated on the same option.
 */
export async function handleValidate(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  headers: Record<string, string> = {},
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  if (!config.allowRequestCode) rejectRequestCode(body);

  let code: MaterializedCode = NO_CODE;
  try {
    if (config.allowRequestCode) {
      // Tools are irrelevant here — nothing is executed — but materializing
      // them keeps a flow that names one from failing validation for a reason
      // the caller cannot see.
      code = materializeRequestCode(body as RequestCode, config);
    }

    const plugins =
      code.pluginPaths.length > 0
        ? await loadPlugins(code.pluginPaths)
        : PluginRegistry.empty();

    const pf = resolveFlow(body as FlowRequest, config, plugins);
    const graph = compile(pf, { plugins });
    validate(graph);

    sendJson(
      res,
      200,
      {
        valid: true,
        flow: graph.name,
        startNode: graph.start,
        nodes: [...graph.nodes.values()].map((n) => ({
          name: n.name,
          type: n.type,
        })),
      },
      headers,
    );
  } finally {
    code.dispose();
  }
}
