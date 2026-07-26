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
import { sendJson, sendText } from './http.js';
import { ConcurrencyGate } from './limits.js';
import { Lifecycle } from './lifecycle.js';
import { renderMetrics } from './metrics.js';
import { handleRun } from './runs.js';
import { handleValidate } from './validate.js';

export const VERSION = '0.2.0-beta.1';

/** Live per-instance state that outlives a single request. */
interface Runtime {
  gate: ConcurrencyGate;
  lifecycle: Lifecycle;
}

/**
 * Build the HTTP server. Does not listen — see {@link startServer}.
 *
 * Routing is hand-rolled on node:http rather than delegated to a framework.
 * The surface is a handful of routes, and this package is a remote-code-
 * execution surface: keeping its production dependency list at exactly one
 * entry (@heddle/core) is worth more here than the ergonomics of a router.
 */
export function createServer(options: ServerOptions = {}): Server {
  const config = resolveConfig(options);
  return buildRouter(config, newRuntime(config));
}

/** The live state a server instance owns, distinct from its static config. */
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

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const method = req.method ?? 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const headers = corsHeaders(req, config);
  const { gate, lifecycle } = runtime;

  // Liveness: true for as long as the event loop answers. It does not track
  // draining — a draining process is still alive and must not be restarted.
  if (method === 'GET' && (path === '/healthz' || path === '/')) {
    sendJson(res, 200, { status: 'ok', version: VERSION }, headers);
    return;
  }

  // Readiness: the switch Kubernetes watches to route work. It goes 503 the
  // moment draining begins, so the pod leaves the Service endpoints while its
  // open streams finish.
  if (method === 'GET' && path === '/readyz') {
    if (lifecycle.isDraining) {
      sendJson(res, 503, { status: 'draining' }, headers);
    } else {
      sendJson(res, 200, { status: 'ok' }, headers);
    }
    return;
  }

  // Scrape target. Unauthenticated by design and meant for in-cluster
  // collection only — an ingress must not route /metrics to the public.
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
    // Refuse new runs once draining: readiness has already pulled us from
    // rotation, but a connection opened in the gap still lands here, and it
    // belongs on a replica that will outlive it.
    if (lifecycle.isDraining) {
      throw new HttpError(503, 'server is draining; retry against another replica', 'Draining');
    }
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
  /**
   * Stop accepting work, let in-flight runs finish, then close. Resolves once
   * the listener is closed — see {@link drainServer}.
   */
  drain: () => Promise<void>;
  /** Close immediately, cutting any open stream. Prefer {@link drain}. */
  close: () => Promise<void>;
}

/**
 * True when a close failed only because the server was already closed.
 *
 * Shutting down twice is a legitimate sequence — `drain()` then `close()` as a
 * backstop, or a signal arriving while a drain is under way — and neither call
 * should reject for finding the work already done.
 */
function isAlreadyClosed(err: Error): boolean {
  return (err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';
}

/**
 * Retire a server without cutting the runs it is streaming.
 *
 * The order matters, and it is the whole point:
 *
 *  1. Flip readiness. `/readyz` answers 503 and `POST /v1/runs` is refused,
 *     while the listener stays open.
 *  2. Wait for the gate to empty — for every open SSE stream to reach its own
 *     natural end.
 *  3. Then stop listening and close.
 *  4. Only if the deadline passes, force the remainder closed.
 *
 * Step 4 is the escape hatch, not the mechanism. Closing every connection up
 * front — which is what this replaced — terminates every live stream on the
 * spot, so every rolling deploy and every scale-in drops runs mid-flight.
 *
 * Keeping the listener open through step 2 is deliberate. Closing it at step 1
 * costs nothing in safety but makes the drain invisible: a readiness probe gets
 * a refused connection instead of the 503 it is meant to observe, and a client
 * that arrives a moment late gets a connection reset rather than a status it
 * can act on. A draining pod should still be able to say that it is draining.
 */
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
      if (err && !isAlreadyClosed(err)) {
        reject(err);
        return;
      }
      resolve();
    };

    /** Stop listening, then wait out whatever connections remain. */
    const closeListener = (): void => {
      server.close(finish);
      // `server.close` will not complete while a keep-alive connection sits
      // idle between requests, so retire those explicitly. Node only gained
      // this in 18.2 — hence the optional call, as elsewhere here.
      server.closeIdleConnections?.();
    };

    const poll = setInterval(() => {
      if (gate.inFlight === 0) closeListener();
    }, 100);

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

    // Neither timer should be what keeps the process alive.
    deadline.unref?.();
    poll.unref?.();

    // Fast path: nothing to wait for.
    if (gate.inFlight === 0) closeListener();
  });
}

/** Build the server and bind it, warning if it is reachable off-host. */
export function startServer(options: ServerOptions = {}): Promise<StartedServer> {
  const config = resolveConfig(options);
  const runtime = newRuntime(config);
  const server = buildRouter(config, runtime);

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
      config.log(`  max concurrent runs: ${config.maxConcurrentRuns}`);
      config.log(`  drain timeout: ${config.drainTimeout}ms`);

      resolve({
        server,
        host: config.host,
        port,
        drain: () => drainServer(server, runtime, config.drainTimeout, config.log),
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err && !isAlreadyClosed(err) ? fail(err) : done()));
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
