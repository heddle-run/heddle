import { DEFAULT_RUNNER_OPTIONS, type Sandbox } from '@heddle/core';

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
