import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';

/**
 * Cross-origin access, off unless origins are configured.
 *
 * Worth being clear about what this does and does not do. CORS is a rule
 * browsers apply to themselves: it decides whether *page JavaScript* may read a
 * response. It stops nothing else — curl, a script, or any non-browser client
 * ignores it entirely. Allowing an origin here therefore widens who can use the
 * server from a web page; it is not what keeps anyone else out.
 *
 * The playground needs it because the site is a static export served from
 * heddle.run while the engine answers on a different origin.
 */

const ALLOWED_HEADERS = 'content-type';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * The value to echo back, or undefined when the request must not be granted
 * cross-origin access.
 *
 * A configured origin is matched exactly rather than by prefix: `https://heddle.run`
 * must not also admit `https://heddle.run.attacker.example`.
 */
export function allowedOrigin(
  origin: string | undefined,
  corsOrigins: string[],
): string | undefined {
  if (corsOrigins.length === 0) return undefined;
  if (corsOrigins.includes('*')) return '*';
  if (!origin) return undefined;
  return corsOrigins.includes(origin) ? origin : undefined;
}

/** Headers granting cross-origin access, or an empty object when it is denied. */
export function corsHeaders(
  req: IncomingMessage,
  config: ServerConfig,
): Record<string, string> {
  const origin = allowedOrigin(
    typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
    config.corsOrigins,
  );
  if (!origin) return {};

  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': '600',
  };

  // Responses differ by Origin, so a shared cache must not serve one origin's
  // response to another. Omitted for `*`, where there is nothing to vary on.
  if (origin !== '*') headers.vary = 'Origin';

  return headers;
}

/**
 * Answer a preflight. Returns true when the request was a preflight and has
 * been handled, so the caller should stop routing it.
 */
export function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): boolean {
  if (req.method !== 'OPTIONS') return false;

  const headers = corsHeaders(req, config);
  // 204 either way: a denied preflight simply carries no allow headers, which
  // is what tells the browser to block the real request.
  res.writeHead(204, { ...headers, 'content-length': '0' });
  res.end();
  return true;
}
