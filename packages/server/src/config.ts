import {
  createWorkspaceFactory,
  DEFAULT_RUNNER_OPTIONS,
  FileRegistry,
  type PluginRegistry,
  type Registry,
  type Sandbox,
  type SessionStore,
  type WorkspaceFactory,
} from '@heddle-run/core';

export interface ServerConfig {
  host: string;
  port: number;
  toolsDir?: string;
  /**
   * `toolsDir`, scanned once and shared by every run.
   *
   * A function rather than a `Registry`, so a directory that is unreadable at
   * startup fails the first request that needs it — exactly where the
   * per-request scan used to fail — instead of keeping the server from
   * starting. The scan is cached on first success; what the directory held
   * then is what every run resolves against.
   */
  toolsRegistry: () => Registry;
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
   * Whether a tool can reach a peer by name from inside the workspace.
   *
   * On by default. Off is what an operator running an approval gate wants: the
   * gate sees the calls the model made, and a tool that exec'd a peer made a
   * call it never saw. See `workspace/bin.ts`.
   */
  mountTools: boolean;
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
   * Where conversations are kept, if the operator turned them on.
   *
   * Absent by default, and its absence is a refusal rather than a fallback: a
   * request naming a session gets a 400 saying this server keeps none. Turning
   * it on is a decision with two costs the operator should be making
   * deliberately — this process starts writing conversations to disk, and it
   * stops being stateless, so two replicas backed by the file store do not
   * share sessions. The pluggable store is the answer to the second, and is why
   * this is a `SessionStore` rather than a directory.
   */
  sessionStore?: SessionStore;
  /** What `/v1/capabilities` calls the store above. */
  sessionStoreName?: string;
  /**
   * How many times one arrival at a node may be attempted.
   *
   * Only reachable by middleware — nothing else retries a node — so it is here
   * for the same reason `plugins` is, and it stays refused in a request body.
   * A caller who could raise it could make the server spend its own budget.
   */
  maxNodeAttempts: number;
  /**
   * The most model responses one agent node may use, the answer included.
   *
   * Server-side for the same reason `maxNodeAttempts` is: a caller who could
   * raise it could make the server spend its own budget.
   */
  maxToolRounds: number;
  defaultLlmKey?: string;
  defaultLlmUrl?: string;
  stream: boolean;
  workDir?: string;
  maxRequestTools: number;
  maxRequestPlugins: number;
  /**
   * How many files one request may put in its own workspaces.
   *
   * Counted rather than only sized, because each one is a mount: it is copied
   * into every node's workspace, and the copy is per node rather than per run.
   * `maxRequestCodeBytes` bounds what the bytes cost; this bounds what the
   * traversal does.
   */
  maxRequestFiles: number;
  maxRequestCodeBytes: number;
  maxConcurrentRuns: number;
  drainTimeout: number;
  /**
   * A shared bearer token every request must present, when set.
   *
   * Absent by default, and absence changes nothing: the server stays the
   * unauthenticated loopback service it has always been, protected by its
   * bind address or by whatever the operator terminated in front of it. The
   * token exists for the local-front-end case — a desktop app spawning this
   * server on loopback wants the port it opened to answer only to itself,
   * not to every process on the machine. It is a shared secret, not accounts:
   * one token, and whoever holds it is the operator. See `auth.ts` for what
   * stays open (health probes) and how the comparison is made.
   */
  authToken?: string;
}

export type ServerOptions = Partial<ServerConfig>;

const ONE_MEBIBYTE = 1024 * 1024;

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4319;
export const DEFAULT_MAX_BODY_BYTES = ONE_MEBIBYTE;
export const DEFAULT_MAX_REQUEST_TOOLS = 10;
export const DEFAULT_MAX_REQUEST_PLUGINS = 5;
export const DEFAULT_MAX_REQUEST_FILES = 20;
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
    toolsRegistry: options.toolsRegistry ?? scannedOnce(options.toolsDir),
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
    mountTools: options.mountTools ?? true,
    plugins: options.plugins,
    pluginConfig: options.pluginConfig ?? {},
    sessionStore: options.sessionStore,
    sessionStoreName: options.sessionStoreName,
    maxNodeAttempts:
      options.maxNodeAttempts ?? DEFAULT_RUNNER_OPTIONS.maxNodeAttempts,
    maxToolRounds:
      options.maxToolRounds ?? DEFAULT_RUNNER_OPTIONS.maxToolRounds,
    defaultLlmKey: options.defaultLlmKey,
    defaultLlmUrl: options.defaultLlmUrl,
    stream: options.stream ?? true,
    workDir: options.workDir,
    maxRequestTools: options.maxRequestTools ?? DEFAULT_MAX_REQUEST_TOOLS,
    maxRequestPlugins: options.maxRequestPlugins ?? DEFAULT_MAX_REQUEST_PLUGINS,
    maxRequestFiles: options.maxRequestFiles ?? DEFAULT_MAX_REQUEST_FILES,
    maxRequestCodeBytes:
      options.maxRequestCodeBytes ?? DEFAULT_MAX_REQUEST_CODE_BYTES,
    maxConcurrentRuns:
      options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
    drainTimeout: options.drainTimeout ?? DEFAULT_DRAIN_TIMEOUT,
    authToken: options.authToken,
  };
}

function scannedOnce(toolsDir: string | undefined): () => Registry {
  let registry: Registry | undefined;
  return () => (registry ??= FileRegistry.create(toolsDir ?? ''));
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
