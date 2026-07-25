import type { IncomingMessage, ServerResponse } from 'node:http';
import { compile, validate } from '@heddle/core';
import type { ServerConfig } from './config.js';
import { resolveFlow, type FlowRequest } from './flow-source.js';
import { readJsonBody, sendJson } from './http.js';

/**
 * POST /v1/validate — parse, compile and validate a flow without running it.
 *
 * No tool registry and no executor are supplied: validation must not depend on
 * the server's tools directory, and must not be able to run anything.
 */
export async function handleValidate(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const body = await readJsonBody(req, config.maxBodyBytes);

  const pf = resolveFlow(body as FlowRequest, config);
  const graph = compile(pf, {});
  validate(graph);

  sendJson(res, 200, {
    valid: true,
    flow: graph.name,
    startNode: graph.start,
    nodes: [...graph.nodes.values()].map((n) => ({
      name: n.name,
      type: n.type,
    })),
  });
}
