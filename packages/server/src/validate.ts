import type { IncomingMessage, ServerResponse } from 'node:http';
import { compile, validate, PluginRegistry } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { resolveFlow, type FlowRequest } from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';
import { buildPlugins } from './plugins.js';
import {
  materializeRequestCode,
  rejectRequestCode,
  NO_CODE,
  type MaterializedCode,
  type RequestCode,
} from './request-code.js';

export async function handleValidate(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  headers: Record<string, string> = {},
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);
  if (!config.allowRequestCode) rejectRequestCode(body);

  let code: MaterializedCode = NO_CODE;
  let plugins = PluginRegistry.empty();

  try {
    if (config.allowRequestCode) {
      code = materializeRequestCode(body as RequestCode, config);
    }
    // Unconditionally: a flow naming an installed plugin's component type has
    // to validate here or it would be refused by the endpoint that runs nothing
    // and then run perfectly well, which is the worst answer available.
    plugins = buildPlugins(config, code);

    const flow = resolveFlow(body as FlowRequest, config, plugins);
    const graph = compile(flow, { plugins });
    validate(graph);

    sendJson(
      res,
      200,
      {
        valid: true,
        flow: graph.name,
        startNode: graph.start,
        nodes: [...graph.nodes.values()].map((node) => ({
          name: node.name,
          type: node.type,
        })),
      },
      headers,
    );
  } finally {
    plugins.dispose();
    code.dispose();
  }
}
