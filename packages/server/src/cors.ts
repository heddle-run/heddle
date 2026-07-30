import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from './config.js';

const ALLOWED_HEADERS = 'content-type';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const PREFLIGHT_MAX_AGE = '600';
const ANY_ORIGIN = '*';

export function allowedOrigin(
  origin: string | undefined,
  corsOrigins: string[],
): string | undefined {
  if (corsOrigins.length === 0) return undefined;
  if (corsOrigins.includes(ANY_ORIGIN)) return ANY_ORIGIN;
  if (!origin) return undefined;

  return corsOrigins.includes(origin) ? origin : undefined;
}

export function corsHeaders(
  req: IncomingMessage,
  config: ServerConfig,
): Record<string, string> {
  const origin = allowedOrigin(requestOrigin(req), config.corsOrigins);
  if (!origin) return {};

  const headers: Record<string, string> = {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': ALLOWED_METHODS,
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': PREFLIGHT_MAX_AGE,
  };

  if (origin !== ANY_ORIGIN) headers.vary = 'Origin';

  return headers;
}

export function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): boolean {
  if (req.method !== 'OPTIONS') return false;

  res.writeHead(204, { ...corsHeaders(req, config), 'content-length': '0' });
  res.end();
  return true;
}

function requestOrigin(req: IncomingMessage): string | undefined {
  return typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
}
