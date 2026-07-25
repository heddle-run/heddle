/**
 * Public API of the HTTP server.
 *
 * Importing this module has no side effects: nothing binds a port until
 * {@link startServer} is called. The executable entry point is
 * `heddle-server.ts`.
 */
export { createServer, startServer, VERSION } from './server.js';
export type { StartedServer } from './server.js';

export {
  resolveConfig,
  isPubliclyBound,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_MAX_BODY_BYTES,
} from './config.js';
export type { ServerConfig, ServerOptions } from './config.js';

export { HttpError, toErrorResponse } from './errors.js';
export type { ErrorBody } from './errors.js';

export { serializeEvent } from './sse.js';
