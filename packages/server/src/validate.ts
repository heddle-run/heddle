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

/**
 * POST /v1/validate — parse, compile and validate a flow without running it.
 *
 * No tool registry and no executor are supplied, so a validated flow cannot
 * run a tool.
 *
 * A flow using a custom `component_type` cannot be parsed without the plugin
 * that defines it, so validating one means loading it. That used to make this
 * endpoint exactly as privileged as `/v1/runs`, because loading meant
 * `import()`ing the submitted module into this process. It no longer does:
 * `loadRemotePlugin` reads the manifest as data, and the plugin's process does
 * not start until a call is made to it (`plugin/host.ts` starts on first
 * `call`). `compile` below does reach `createExecutor`, but for a remote plugin
 * that only builds a wire payload and hands over a tool runner — no call. So
 * validating a flow runs none of the plugin author's code, and a `validate`
 * that returns `valid: true` has proved only that the flow parses.
 *
 * It stays gated on the same option anyway, because loading is not the only
 * cost: the request's tool scripts and plugin modules are still written to
 * disk, still bounded by the same request-code limits, and a server that has
 * not opted into accepting submitted code should not be accepting it here
 * either.
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
  let plugins = PluginRegistry.empty();
  try {
    if (config.allowRequestCode) {
      // Tools are irrelevant here — nothing is executed — but materializing
      // them keeps a flow that names one from failing validation for a reason
      // the caller cannot see.
      code = materializeRequestCode(body as RequestCode, config);
      plugins = buildPlugins(config, code);
    }

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
    plugins.dispose();
    code.dispose();
  }
}
