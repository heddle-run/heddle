import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Paths that answer without a token even when one is configured.
 *
 * Liveness and readiness probes are the callers that cannot carry a header —
 * a load balancer's health check is configured with a URL, not a secret — and
 * neither says anything a port scan would not. Everything else on this server
 * executes or reads on behalf of the caller, so everything else is checked.
 */
const OPEN_PATHS = new Set(['/', '/healthz', '/readyz']);

/**
 * Whether this request may proceed under the configured token.
 *
 * No token configured means every request may: authentication stays opt-in,
 * and an existing deployment behind its reverse proxy sees no change. With a
 * token, the request must carry `Authorization: Bearer <token>` exactly.
 *
 * The comparison hashes both sides before `timingSafeEqual`, which wants
 * equal-length inputs — hashing gives it that without first revealing, by
 * returning early, that the lengths differed.
 */
export function authorized(
  req: IncomingMessage,
  path: string,
  token: string | undefined,
): boolean {
  if (token === undefined || OPEN_PATHS.has(path)) return true;

  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;

  const [scheme, ...rest] = header.split(' ');
  if (scheme !== 'Bearer') return false;

  const presented = rest.join(' ').trim();
  return timingSafeEqual(digest(presented), digest(token));
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf-8').digest();
}
