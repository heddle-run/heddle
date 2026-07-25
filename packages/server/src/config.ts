import { DEFAULT_RUNNER_OPTIONS } from '@heddle/core';

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
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4319;
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

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
  };
}

/** True when the host is something other than a loopback address. */
export function isPubliclyBound(host: string): boolean {
  return !['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1'].includes(host);
}
