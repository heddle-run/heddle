const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-turnstile-token";
const PREFLIGHT_MAX_AGE = "600";
const ANY_ORIGIN = "*";

export function allowedOrigin(
  origin: string | null,
  configured: string[],
): string | undefined {
  if (configured.length === 0) return undefined;
  if (configured.includes(ANY_ORIGIN)) return ANY_ORIGIN;
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
    "access-control-max-age": PREFLIGHT_MAX_AGE,
  };
  if (origin !== ANY_ORIGIN) headers.vary = "Origin";

  return headers;
}

export function preflight(
  request: Request,
  configured: string[],
): Response | undefined {
  if (request.method !== "OPTIONS") return undefined;

  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, configured),
  });
}

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
