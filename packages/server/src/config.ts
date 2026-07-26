import { DEFAULT_RUNNER_OPTIONS, type Sandbox } from '@heddle/core';

/**
 * Server-side configuration, supplied at startup.
 *
 * Everything that decides *what the server is allowed to touch* lives here and
 * only here. None of it is settable per request: this service executes
 * arbitrary local executables on behalf of its callers, so the set of reachable
 * executables and flow files has to be fixed by whoever starts the process.
 */
export interface ServerConfig {
  /**
   * Interface to bind. Defaults to loopback. Binding anywhere else exposes an
   * unauthenticated remote-code-execution surface to the network.
   */
  host: string;
  port: number;
  /**
   * Directory scanned for tool executables. Server-side only — a request can
   * never point the engine at a different directory.
   */
  toolsDir?: string;
  /**
   * Root directory that `flowPath` request fields are resolved against and
   * confined to. When unset, requests may only submit flows inline.
   */
  flowsRoot?: string;
  maxIterations: number;
  /** Wall-clock budget for a single run, in milliseconds. */
  timeout: number;
  /** Maximum accepted request body size, in bytes. */
  maxBodyBytes: number;
  /** Where operational messages go. Defaults to stderr. */
  log: (message: string) => void;

  /**
   * Browser origins allowed to call this server, or `['*']` for any.
   *
   * Empty by default, which sends no CORS headers at all and so keeps browsers
   * from reading responses cross-origin. Note that CORS is not a security
   * control for this service: it constrains browsers, not clients. A shared
   * server still needs the confinement described in {@link allowRequestCode}.
   */
  corsOrigins: string[];

  /**
   * Whether a request may supply its own tool scripts and plugin modules.
   *
   * This is off by default, and turning it on is a decision about the whole
   * host, not about this process. Tool scripts become subprocesses, which
   * {@link sandbox} can confine. Plugin modules cannot be confined at all:
   * heddle loads them with a dynamic `import()`, so they execute inside this
   * Node process with its filesystem access and its environment — including
   * every API key the server was started with.
   *
   * The only sound deployment is therefore one disposable container per run,
   * where the whole process is the untrusted thing and is destroyed after the
   * run. See the deployment section of the README.
   */
  allowRequestCode: boolean;

  /** When set, tool subprocesses are launched through this sandbox. */
  sandbox?: Sandbox;

  /**
   * Where per-run directories for submitted code are created. Defaults to the
   * system temp directory.
   *
   * Worth overriding on Linux when {@link sandbox} is bubblewrap: that backend
   * mounts a fresh tmpfs over `/tmp`, which is exactly where the default lands,
   * and the bind that puts a tool back in view is easier to reason about when
   * the two are not layered.
   */
  workDir?: string;

  /** Ceiling on request-supplied tool scripts, per run. */
  maxRequestTools: number;
  /** Ceiling on request-supplied plugin modules, per run. */
  maxRequestPlugins: number;
  /** Ceiling on the combined size of request-supplied source, in bytes. */
  maxRequestCodeBytes: number;
  /** Runs allowed to execute at once. Further requests are refused with a 429. */
  maxConcurrentRuns: number;

  /**
   * How long SIGTERM waits for in-flight runs before closing what remains.
   *
   * Runs stream over long-lived connections, so a process that exits promptly
   * on SIGTERM cuts them off. Under an orchestrator this is not an edge case —
   * it is every rolling deploy and every scale-in. Set it at or above
   * {@link timeout}, and give the pod a `terminationGracePeriodSeconds` above
   * this, so the drain is not itself cut short by a SIGKILL.
   */
  drainTimeout: number;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4319;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB
export const DEFAULT_MAX_REQUEST_TOOLS = 10;
export const DEFAULT_MAX_REQUEST_PLUGINS = 5;
export const DEFAULT_MAX_REQUEST_CODE_BYTES = 256 * 1024; // 256 KiB
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
/**
 * How long a draining process waits for in-flight runs to finish before it
 * force-closes what remains and exits. Should be set at least as high as
 * `--timeout` so a run near its wall-clock budget can still complete, and the
 * pod's `terminationGracePeriodSeconds` should exceed it so Kubernetes does not
 * SIGKILL mid-drain.
 */
export const DEFAULT_DRAIN_TIMEOUT = 30_000;

export type ServerOptions = Partial<ServerConfig>;

export function resolveConfig(options: ServerOptions = {}): ServerConfig {
  return {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    toolsDir: options.toolsDir,
    flowsRoot: options.flowsRoot,
    maxIterations: options.maxIterations ?? DEFAULT_RUNNER_OPTIONS.maxIterations,
    timeout: options.timeout ?? DEFAULT_RUNNER_OPTIONS.timeout,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    log: options.log ?? ((message) => process.stderr.write(`${message}\n`)),
    corsOrigins: options.corsOrigins ?? [],
    allowRequestCode: options.allowRequestCode ?? false,
    sandbox: options.sandbox,
    workDir: options.workDir,
    maxRequestTools: options.maxRequestTools ?? DEFAULT_MAX_REQUEST_TOOLS,
    maxRequestPlugins: options.maxRequestPlugins ?? DEFAULT_MAX_REQUEST_PLUGINS,
    maxRequestCodeBytes:
      options.maxRequestCodeBytes ?? DEFAULT_MAX_REQUEST_CODE_BYTES,
    maxConcurrentRuns: options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
    drainTimeout: options.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT,
  };
}

/** True when the host is something other than a loopback address. */
export function isPubliclyBound(host: string): boolean {
  return !['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
}
