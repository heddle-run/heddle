/**
 * Cross-origin access for the playground page.
 *
 * The engine has its own CORS handling, but nothing here forwards to it: the
 * broker answers the browser, so the broker is what the browser's rules apply
 * to. Engine responses are re-headed on the way out.
 *
 * As on the engine, this constrains browsers and nothing else. It is not what
 * keeps anyone out — that is the rate limiter and, if configured, Turnstile.
 */

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-turnstile-token";

/** Origins are matched exactly: a prefix test would admit heddle.run.evil.com. */
export function allowedOrigin(
  origin: string | null,
  configured: string[],
): string | undefined {
  if (configured.length === 0) return undefined;
  if (configured.includes("*")) return "*";
  if (!origin) return undefined;
  return configured.includes(origin) ? origin : undefined;
}

export function corsHeaders(
  request: Request,
  configured: string[],
): Record<string, string> {
  const origin = allowedOrigin(request.headers.get("origin"), configured);
  if (!origin) return {};

  const headers: Record<string, string> = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    "access-control-max-age": "600",
  };
  if (origin !== "*") headers.vary = "Origin";
  return headers;
}

/** Answer a preflight, or return undefined when this is not one. */
export function preflight(
  request: Request,
  configured: string[],
): Response | undefined {
  if (request.method !== "OPTIONS") return undefined;
  // A denied preflight is a 204 with no allow headers, which is what tells the
  // browser to block the request it was asking about.
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, configured),
  });
}

/** Copy a response, adding the CORS headers. Preserves a streaming body. */
export function withCors(
  response: Response,
  headers: Record<string, string>,
): Response {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) merged.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

export function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

export function error(
  type: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { type, message } }, status, headers);
}
