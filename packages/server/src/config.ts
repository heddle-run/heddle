import {
  createWorkspaceFactory,
  DEFAULT_RUNNER_OPTIONS,
  type PluginRegistry,
  type Sandbox,
  type WorkspaceFactory,
} from '@heddle/core';

export interface ServerConfig {
  host: string;
  port: number;
  toolsDir?: string;
  flowsRoot?: string;
  maxIterations: number;
  timeout: number;
  pluginCallTimeout: number;
  maxBodyBytes: number;
  log: (message: string) => void;
  corsOrigins: string[];
  allowRequestCode: boolean;
  /**
   * Private hosts a submitted spec may reach anyway.
   *
   * Only consulted under `--allow-request-code`, because that is the only mode
   * in which a spec's author and this server's operator are different people.
   * See `egress.ts` in core for what is refused by default and what is not.
   */
  allowNet: string[];
  sandbox?: Sandbox;
  /**
   * What every node's workspace starts with, and where it lives.
   *
   * Fixed at startup, like `sandbox`, and for the same reason: a request may
   * not choose what is in the working directory of every node of every run.
   * Unlike the sandbox it is never absent — a workspace exists on every run,
   * and this decides only what is in it.
   */
  workspaces: WorkspaceFactory;
  /**
   * Plugins the operator installed, already loaded.
   *
   * The other half of the plugin system, and the half a request cannot reach.
   * Middleware runs on every node of every flow and takes its configuration
   * from the command line, so it is installed here or not at all — a submitted
   * plugin declaring any is refused, whatever else it provides.
   *
   * Loaded once and shared by every run: one process, however many requests.
   * That is what makes an MCP session or a connection pool worth having, and it
   * is why these plugins are started with `shared` — see
   * `PluginHostOptions.shared` for what a shared host stops doing.
   *
   * Held rather than loaded here because loading is asynchronous and
   * `createServer` is not. {@link startServer} takes ownership: draining or
   * closing the server disposes it.
   */
  plugins?: PluginRegistry;
  /** Settings for installed middleware, by componentType. */
  pluginConfig: Record<string, Record<string, unknown>>;
  /**
   * How many times one arrival at a node may be attempted.
   *
   * Only reachable by middleware — nothing else retries a node — so it is here
   * for the same reason `plugins` is, and it stays refused in a request body.
   * A caller who could raise it could make the server spend its own budget.
   */
  maxNodeAttempts: number;
  defaultLlmKey?: string;
  defaultLlmUrl?: string;
  stream: boolean;
  workDir?: string;
  maxRequestTools: number;
  maxRequestPlugins: number;
  maxRequestCodeBytes: number;
  maxConcurrentRuns: number;
  drainTimeout: number;
}

export type ServerOptions = Partial<ServerConfig>;

const ONE_MEBIBYTE = 1024 * 1024;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4319;
export const DEFAULT_MAX_BODY_BYTES = ONE_MEBIBYTE;
export const DEFAULT_MAX_REQUEST_TOOLS = 10;
export const DEFAULT_MAX_REQUEST_PLUGINS = 5;
export const DEFAULT_MAX_REQUEST_CODE_BYTES = 256 * 1024;
export const DEFAULT_MAX_CONCURRENT_RUNS = 4;
export const DEFAULT_PLUGIN_CALL_TIMEOUT = 30_000;
export const DEFAULT_DRAIN_TIMEOUT = 30_000;

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'];

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);
const FALSY = new Set(['0', 'false', 'off', 'no']);

export function resolveConfig(options: ServerOptions = {}): ServerConfig {
  return {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? DEFAULT_PORT,
    toolsDir: options.toolsDir,
    flowsRoot: options.flowsRoot,
    maxIterations:
      options.maxIterations ?? DEFAULT_RUNNER_OPTIONS.maxIterations,
    timeout: options.timeout ?? DEFAULT_RUNNER_OPTIONS.timeout,
    pluginCallTimeout:
      options.pluginCallTimeout ?? DEFAULT_PLUGIN_CALL_TIMEOUT,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    log: options.log ?? writeToStderr,
    corsOrigins: options.corsOrigins ?? [],
    allowRequestCode: options.allowRequestCode ?? false,
    allowNet: options.allowNet ?? [],
    sandbox: options.sandbox,
    workspaces: options.workspaces ?? createWorkspaceFactory(),
    plugins: options.plugins,
    pluginConfig: options.pluginConfig ?? {},
    maxNodeAttempts:
      options.maxNodeAttempts ?? DEFAULT_RUNNER_OPTIONS.maxNodeAttempts,
    defaultLlmKey: options.defaultLlmKey,
    defaultLlmUrl: options.defaultLlmUrl,
    stream: options.stream ?? true,
    workDir: options.workDir,
    maxRequestTools: options.maxRequestTools ?? DEFAULT_MAX_REQUEST_TOOLS,
    maxRequestPlugins: options.maxRequestPlugins ?? DEFAULT_MAX_REQUEST_PLUGINS,
    maxRequestCodeBytes:
      options.maxRequestCodeBytes ?? DEFAULT_MAX_REQUEST_CODE_BYTES,
    maxConcurrentRuns:
      options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
    drainTimeout: options.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT,
  };
}

export function boolEnv(
  name: string,
  raw: string | undefined,
): boolean | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;

  const value = raw.trim().toLowerCase();
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;

  throw new Error(
    `${name} must be one of ${[...TRUTHY, ...FALSY].join(', ')}, got "${raw}"`,
  );
}

export function isPubliclyBound(host: string): boolean {
  return !LOOPBACK_HOSTS.includes(host);
}

function writeToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}
