import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { resolveConfig, isPubliclyBound, type ServerConfig, type ServerOptions } from './config.js';
import { handleCapabilities } from './capabilities.js';
import { corsHeaders, handlePreflight } from './cors.js';
import { toErrorResponse, HttpError } from './errors.js';
import { sendJson } from './http.js';
import { ConcurrencyGate } from './limits.js';
import { handleRun } from './runs.js';
import { handleValidate } from './validate.js';

export const VERSION = '0.2.0-beta.1';

/**
 * Build the HTTP server. Does not listen — see {@link startServer}.
 *
 * Routing is hand-rolled on node:http rather than delegated to a framework.
 * The surface is five routes, and this package is a remote-code-execution
 * surface: keeping its production dependency list at exactly one entry
 * (@heddle/core) is worth more here than the ergonomics of a router.
 */
export function createServer(options: ServerOptions = {}): Server {
  const config = resolveConfig(options);
  // Owned by the server instance, not by the config: it is live state, and
  // resolveConfig is called on both paths into here.
  const gate = new ConcurrencyGate(config.maxConcurrentRuns);

  return createHttpServer((req, res) => {
    void route(req, res, config, gate).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const { status, body } = toErrorResponse(err);
      sendJson(res, status, body, corsHeaders(req, config));
    });
  });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
  gate: ConcurrencyGate,
): Promise<void> {
  if (handlePreflight(req, res, config)) return;

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const headers = corsHeaders(req, config);

  if (method === 'GET' && (path === '/healthz' || path === '/')) {
    sendJson(res, 200, { status: 'ok', version: VERSION }, headers);
    return;
  }

  if (path === '/v1/capabilities') {
    requireMethod(method, 'GET');
    handleCapabilities(res, config, gate, VERSION, headers);
    return;
  }

  if (path === '/v1/runs') {
    requireMethod(method, 'POST');
    const stream = url.searchParams.get('stream') === 'true';
    await handleRun(req, res, config, gate, stream, headers);
    return;
  }

  if (path === '/v1/validate') {
    requireMethod(method, 'POST');
    await handleValidate(req, res, config, headers);
    return;
  }

  throw new HttpError(404, `no route for ${method} ${path}`, 'NotFound');
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new HttpError(405, `method ${actual} not allowed; use ${expected}`, 'MethodNotAllowed');
  }
}

export interface StartedServer {
  server: Server;
  host: string;
  port: number;
  close: () => Promise<void>;
}

/** Build the server and bind it, warning if it is reachable off-host. */
export function startServer(options: ServerOptions = {}): Promise<StartedServer> {
  const config = resolveConfig(options);
  const server = createServer(config);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : config.port;

      if (isPubliclyBound(config.host)) {
        config.log(
          `WARNING: heddle-server is bound to ${config.host}:${port}, which may be reachable from ` +
            `other hosts. There is NO AUTHENTICATION, and every request can execute the ` +
            `executables in the configured tools directory. Do not expose this to a network ` +
            `you do not fully control.`,
        );
      }

      if (config.allowRequestCode) {
        config.log(
          `WARNING: --allow-request-code is on. Every request may submit tool scripts and ` +
            `plugin modules, and plugin modules are imported into THIS process — they run ` +
            `with its filesystem access and its environment, including any API keys. ` +
            `Tool sandboxing does not confine them. Run this configuration only as one ` +
            `disposable container per run.`,
        );
      }

      config.log(`heddle-server listening on http://${config.host}:${port}`);
      config.log(`  tools dir: ${config.toolsDir ?? '(none — tool nodes will fail)'}`);
      config.log(`  flows root: ${config.flowsRoot ?? '(none — inline flows only)'}`);
      config.log(`  sandbox: ${config.sandbox?.name ?? '(none — tools run unconfined)'}`);
      config.log(`  request code: ${config.allowRequestCode ? 'accepted' : 'refused'}`);
      config.log(
        `  cors: ${config.corsOrigins.length > 0 ? config.corsOrigins.join(', ') : '(none)'}`,
      );

      resolve({
        server,
        host: config.host,
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
