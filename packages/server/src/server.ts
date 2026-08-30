import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { checkMiddlewareConfig } from '@heddle-run/core';
import {
  resolveConfig,
  isPubliclyBound,
  type ServerConfig,
  type ServerOptions,
} from './config.js';
import { authorized } from './auth.js';
import {
  handleDeleteBundle,
  handleReadBundle,
  handleUploadBundle,
} from './bundles.js';
import { handleCapabilities } from './capabilities.js';
import { corsHeaders, handlePreflight } from './cors.js';
import { toErrorResponse, HttpError } from './errors.js';
import { sendJson, sendText } from './http.js';
import { ConcurrencyGate } from './limits.js';
import { Lifecycle } from './lifecycle.js';
import { renderMetrics } from './metrics.js';
import { handleRun } from './runs.js';
import {
  handleCreateSession,
  handleDeleteSession,
  handleReadSession,
} from './sessions.js';
import { handleValidate } from './validate.js';

export const VERSION = '0.2.0-beta.1';

const DRAIN_POLL_INTERVAL = 100;
const TRAILING_SLASHES = /\/+$/;

interface Runtime {
  gate: ConcurrencyGate;
  lifecycle: Lifecycle;
}

export interface StartedServer {
  server: Server;
  host: string;
  port: number;
  drain: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Build the router without binding a port.
 *
 * Unlike {@link startServer} this takes no ownership of `options.plugins`,
 * because it hands back nothing that could later release them: a caller that
 * loads plugins and calls this disposes them itself.
 */
export function createServer(options: ServerOptions = {}): Server {
  const config = resolveConfig(options);
  checkMiddlewareConfig(config.plugins, config.pluginConfig);

  return buildRouter(config, newRuntime(config));
}

/**
 * Bind a port and serve.
 *
 * Takes ownership of `options.plugins`: draining or closing the returned server
 * disposes it, which is what stops the plugin processes. They outlive every
 * individual run by design, so nothing else is left to stop them — and a
 * SIGTERM that left them running would orphan a process per installed plugin.
 */
// `async` so that a bad configuration is a rejection rather than a throw from a
// function that otherwise returns a promise. A caller reaching for `.catch` is
// not wrong to expect it to catch everything.
export async function startServer(
  options: ServerOptions = {},
): Promise<StartedServer> {
  const config = resolveConfig(options);
  checkMiddlewareConfig(config.plugins, config.pluginConfig);

  const runtime = newRuntime(config);
  const server = buildRouter(config, runtime);
  const stopPlugins = (): void => config.plugins?.dispose();

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      const port = boundPort(server, config.port);

      announce(config, port);

      resolve({
        server,
        host: config.host,
        port,
        drain: () =>
          drainServer(server, runtime, config.drainTimeout, config.log).finally(
            stopPlugins,
          ),
        close: () => closeServer(server).finally(stopPlugins),
      });
    });
  });
}

export function drainServer(
  server: Server,
  runtime: Runtime,
  timeoutMs: number,
  log: (message: string) => void,
): Promise<void> {
  const { gate, lifecycle } = runtime;
  lifecycle.beginDrain();

  log(
    gate.inFlight > 0
      ? `draining: refusing new runs, waiting up to ${timeoutMs}ms for ${gate.inFlight} in flight`
      : 'draining: no runs in flight',
  );

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (err?: Error | null): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);

      if (err && !isAlreadyClosed(err)) reject(err);
      else resolve();
    };

    const closeListener = (): void => {
      server.close(finish);
      server.closeIdleConnections?.();
    };

    const poll = setInterval(() => {
      if (gate.inFlight === 0) closeListener();
    }, DRAIN_POLL_INTERVAL);

    const deadline = setTimeout(() => {
      if (settled) return;
      log(
        `drain timed out after ${timeoutMs}ms with ${gate.inFlight} run(s) still in flight; ` +
          `closing connections`,
      );
      server.close(finish);
      server.closeAllConnections?.();
      finish();
    }, timeoutMs);

    deadline.unref?.();
    poll.unref?.();

    if (gate.inFlight === 0) closeListener();
  });
}

function newRuntime(config: ServerConfig): Runtime {
  return {
    gate: new ConcurrencyGate(config.maxConcurrentRuns),
    lifecycle: new Lifecycle(),
  };
}

function buildRouter(config: ServerConfig, runtime: Runtime): Server {
  return createHttpServer((req, res) => {
    void route(req, res, config, runtime).catch((err) => {
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
  runtime: Runtime,
): Promise<void> {
  if (handlePreflight(req, res, config)) return;

  const url = requestUrl(req);
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(TRAILING_SLASHES, '') || '/';
  const headers = corsHeaders(req, config);
  const { gate, lifecycle } = runtime;

  // Before any route: past this line a request executes or reads on the
  // caller's behalf. CORS preflights were answered above — a browser sends
  // those without credentials, and refusing one only hides the real error.
  if (!authorized(req, path, config.authToken)) {
    throw new HttpError(
      401,
      'this server requires a bearer token; pass "Authorization: Bearer <token>"',
      'Unauthorized',
    );
  }

  if (method === 'GET' && (path === '/healthz' || path === '/')) {
    sendJson(res, 200, { status: 'ok', version: VERSION }, headers);
    return;
  }

  if (method === 'GET' && path === '/readyz') {
    if (lifecycle.isDraining) {
      sendJson(res, 503, { status: 'draining' }, headers);
    } else {
      sendJson(res, 200, { status: 'ok' }, headers);
    }
    return;
  }

  if (method === 'GET' && path === '/metrics') {
    sendText(res, 200, renderMetrics(gate), headers);
    return;
  }

  if (path === '/v1/capabilities') {
    requireMethod(method, 'GET');
    handleCapabilities(res, config, gate, VERSION, headers);
    return;
  }

  if (path === '/v1/runs') {
    requireMethod(method, 'POST');
    if (lifecycle.isDraining) {
      throw new HttpError(
        503,
        'server is draining; retry against another replica',
        'Draining',
      );
    }

    await handleRun(
      req,
      res,
      config,
      gate,
      url.searchParams.get('stream') === 'true',
      url.searchParams.get('protocol'),
      headers,
    );
    return;
  }

  if (path === '/v1/validate') {
    requireMethod(method, 'POST');
    await handleValidate(req, res, config, headers);
    return;
  }

  if (path === '/v1/sessions') {
    requireMethod(method, 'POST');
    await handleCreateSession(req, res, config, headers);
    return;
  }

  const sessionId = sessionPath(path);
  if (sessionId) {
    if (method === 'GET') {
      await handleReadSession(res, config, sessionId, headers);
      return;
    }
    if (method === 'DELETE') {
      await handleDeleteSession(res, config, sessionId, headers);
      return;
    }
    throw new HttpError(
      405,
      `method ${method} not allowed; use GET or DELETE`,
      'MethodNotAllowed',
    );
  }

  if (path === '/v1/bundles') {
    requireMethod(method, 'POST');
    await handleUploadBundle(req, res, config, headers);
    return;
  }

  const bundleId = bundlePath(path);
  if (bundleId) {
    if (method === 'GET') {
      handleReadBundle(res, config, bundleId, headers);
      return;
    }
    if (method === 'DELETE') {
      handleDeleteBundle(res, config, bundleId, headers);
      return;
    }
    throw new HttpError(
      405,
      `method ${method} not allowed; use GET or DELETE`,
      'MethodNotAllowed',
    );
  }

  throw new HttpError(404, `no route for ${method} ${path}`, 'NotFound');
}

/**
 * The id in `/v1/sessions/<id>`, decoded, or nothing if this is another route.
 *
 * Decoded here rather than passed through, because the id is checked against
 * the store's own rule downstream — and a percent-encoded `..` that reached
 * that check still encoded would pass a rule written about the characters it
 * would eventually become.
 */
function sessionPath(path: string): string | undefined {
  const prefix = '/v1/sessions/';
  if (!path.startsWith(prefix)) return undefined;

  const raw = path.slice(prefix.length);
  if (raw.length === 0) return undefined;

  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'session id is not valid percent-encoding');
  }
}

/**
 * The id in `/v1/bundles/<id>`, decoded, or nothing if this is another route.
 *
 * The same decoding stance as {@link sessionPath}, for the same reason: the id
 * is checked against the store's own rule downstream, and that rule is written
 * about the characters a percent-encoded id would eventually become.
 */
function bundlePath(path: string): string | undefined {
  const prefix = '/v1/bundles/';
  if (!path.startsWith(prefix)) return undefined;

  const raw = path.slice(prefix.length);
  if (raw.length === 0) return undefined;

  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'bundle id is not valid percent-encoding');
  }
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
}

function requireMethod(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new HttpError(
      405,
      `method ${actual} not allowed; use ${expected}`,
      'MethodNotAllowed',
    );
  }
}

function boundPort(server: Server, fallback: number): number {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : fallback;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((err) =>
      err && !isAlreadyClosed(err) ? reject(err) : resolve(),
    );
    server.closeAllConnections?.();
  });
}

function isAlreadyClosed(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';
}

function announce(config: ServerConfig, port: number): void {
  if (isPubliclyBound(config.host)) {
    config.log(publicBindWarning(config.host, port));
  }
  if (config.allowRequestCode) {
    config.log(REQUEST_CODE_NOTE);
  }

  config.log(`heddle-server listening on http://${config.host}:${port}`);
  config.log(
    `  tools dir: ${config.toolsDir ?? '(none — tool nodes will fail)'}`,
  );
  config.log(
    `  flows root: ${config.flowsRoot ?? '(none — inline flows only)'}`,
  );
  config.log(
    `  sandbox: ${config.sandbox?.name ?? '(none — tools run unconfined)'}`,
  );
  config.log(`  plugins: ${config.plugins?.describe() ?? 'none'}`);
  config.log(`  middleware: ${describeMiddleware(config)}`);
  config.log(`  sessions: ${describeSessions(config)}`);
  config.log(
    `  request code: ${config.allowRequestCode ? 'accepted' : 'refused'}`,
  );
  config.log(`  bundles: ${describeBundles(config)}`);
  config.log(
    `  cors: ${config.corsOrigins.length > 0 ? config.corsOrigins.join(', ') : '(none)'}`,
  );
  config.log(`  max concurrent runs: ${config.maxConcurrentRuns}`);
  config.log(`  drain timeout: ${config.drainTimeout}ms`);
}

/**
 * What runs on every node of every flow, and where it came from.
 *
 * Worth a line of its own rather than being folded into the plugin list: a
 * middleware is the one component nobody asked for by name, so an operator
 * reading this log is the only person who will ever see it stated.
 */
function describeMiddleware(config: ServerConfig): string {
  const installed = (config.plugins?.middlewareDefs() ?? []).map(
    ({ plugin, def }) => `${def.componentType} (${plugin})`,
  );

  return installed.length > 0 ? installed.join(', ') : 'none';
}

/**
 * Whether conversations are kept, and the two things that follow if they are.
 *
 * Both are properties an operator would otherwise discover in production. A
 * session id is a bearer capability on a server with no authentication, and a
 * replica backed by the file store holds conversations no other replica can
 * see — so the line says which store, not just that there is one.
 */
function describeSessions(config: ServerConfig): string {
  if (!config.sessionStore) return 'off (a request naming one is refused)';

  const name = config.sessionStoreName ?? 'unnamed';
  return name === 'file'
    ? `${name} — kept on this host only, so replicas do not share them; ` +
        `a session id is a bearer capability`
    : `${name} — a session id is a bearer capability`;
}

/**
 * Whether this server takes programs from its callers, said the way the
 * request-code line is said — because a bundle is the stronger grant of the
 * two, and the operator reading this log is the person who owns that decision.
 */
function describeBundles(config: ServerConfig): string {
  if (!config.bundles) return 'refused (--no-bundles)';
  return (
    `accepted, and they run with this server's full rights; ` +
    `store: ${config.bundlesDir}`
  );
}

function publicBindWarning(host: string, port: number): string {
  return (
    `WARNING: heddle-server is bound to ${host}:${port}, which may be reachable from ` +
    `other hosts. There is NO AUTHENTICATION, and every request can execute the ` +
    `executables in the configured tools directory. Do not expose this to a network ` +
    `you do not fully control.`
  );
}

const REQUEST_CODE_NOTE =
  `NOTE: --allow-request-code is on. Callers may submit tool scripts and plugin ` +
  `modules; both run in their own processes and are stopped when the run ends, ` +
  `and submitted specs cannot read this process's environment. What remains ` +
  `yours to bound: this server has no authentication and no rate limiting, it ` +
  `runs computation its callers choose, and it makes outbound requests to hosts ` +
  `they name. Restrict egress and put something in front of it.`;
