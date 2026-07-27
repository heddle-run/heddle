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

  /**
   * Wall-clock budget for a single call into a plugin process, in milliseconds.
   *
   * Deliberately not {@link timeout}. This server passed the whole-run budget
   * here for a while, which meant one `execute` could hold a concurrency slot
   * for the entire run — five minutes at the default — while doing nothing, and
   * the only thing that ever noticed was the run's own deadline. With
   * {@link maxConcurrentRuns} at 4, four hung calls are the whole server.
   *
   * A per-call bound has to be independent of the run budget for the reason the
   * run budget cannot serve as one: a run is entitled to make many plugin calls,
   * so "did this one call stop responding" is not a question the run's deadline
   * can answer. Every method the plugin protocol grows inherits whatever is set
   * here, which is the other reason it should be a small number chosen on
   * purpose rather than a large one inherited by accident.
   *
   * Raise it for a plugin that legitimately blocks: the timer covers the call
   * end to end, including any `runTool` the plugin makes back into the host
   * while its own `execute` is still pending. A plugin that overruns is killed,
   * because a process that may still be mid-reply cannot be trusted to keep the
   * channel unambiguous.
   *
   * Independent of {@link timeout}, but not free of it: `buildPlugins` clamps
   * what it passes to the smaller of the two. Setting this above the run budget
   * would be a bound in name only, since a run cannot end while a plugin call
   * is outstanding — see the clamp in plugins.ts for why the run's own deadline
   * is not enough on its own.
   */
  pluginCallTimeout: number;
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
   * Off by default. Turning it on is safe for a long-lived process serving
   * many concurrent runs, which was not always true:
   *
   * - Tool scripts run as subprocesses, confined by {@link sandbox}.
   * - Plugin modules run in their own process, holding none of this process's
   *   environment, and are killed when the run ends. They used to be
   *   `import()`ed into this process, which is why this option once implied
   *   one container per run.
   * - Submitted specs cannot dereference this process's environment: `$VAR`
   *   in an `llm_config` is refused while this is on.
   *
   * What it does still imply: the engine executes arbitrary computation and
   * makes outbound requests to hosts its callers choose. Bound the compute,
   * restrict egress, and put authentication in front. See DEPLOYMENT.md.
   */
  allowRequestCode: boolean;

  /** When set, tool subprocesses are launched through this sandbox. */
  sandbox?: Sandbox;

  /**
   * A model credential for specs that name none, so a caller can run a flow
   * without bringing a key of their own.
   *
   * Read from the environment at startup rather than taken as a flag, so it
   * does not sit in `ps` output or a shell history. It is never handed to a
   * spec that chooses its own `url` — that request is refused instead, because
   * filling it in would post the key to a host the caller picked.
   */
  defaultLlmKey?: string;
  /** Endpoint the default credential belongs to. */
  defaultLlmUrl?: string;

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
 * Per-call plugin budget. Matches `PluginHost`'s own default, so a plugin
 * behaves the same under this server as it does under a direct
 * `loadRemotePlugin` — the surprise worth avoiding is a plugin that passes its
 * author's tests and then times out only in production, or vice versa.
 */
export const DEFAULT_PLUGIN_CALL_TIMEOUT = 30_000;
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
    pluginCallTimeout:
      options.pluginCallTimeout ?? DEFAULT_PLUGIN_CALL_TIMEOUT,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    log: options.log ?? ((message) => process.stderr.write(`${message}\n`)),
    corsOrigins: options.corsOrigins ?? [],
    allowRequestCode: options.allowRequestCode ?? false,
    sandbox: options.sandbox,
    defaultLlmKey: options.defaultLlmKey,
    defaultLlmUrl: options.defaultLlmUrl,
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
