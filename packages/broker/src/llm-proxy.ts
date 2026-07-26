import { intVar, type Env } from "./env";
import { error } from "./cors";
import { verifyToken } from "./token";

/**
 * The model credential lives here, and only here.
 *
 * A container cannot be trusted with the key. heddle takes an LLM's base URL
 * and credential from the submitted spec, so `api_key: $OPENAI_API_KEY` in an
 * ordinary flow is enough to read the environment and send it somewhere — no
 * plugin, no tool, no escape required. The container is therefore given a
 * signed per-run token, and this route exchanges it for the real key.
 *
 * The exchange is also where a run's model spend is bounded: the token names a
 * run, and a run gets a fixed number of calls.
 */
export async function handleLlmProxy(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const authorization = request.headers.get("authorization") ?? "";
  const presented = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!presented) {
    return error("Unauthorized", "no run token presented", 401);
  }

  const token = await verifyToken(env.RUN_TOKEN_SECRET, presented);
  if (!token) {
    // One message for forged, malformed and expired alike: which of the three
    // it was is information the presenter does not need.
    return error("Unauthorized", "run token is not valid", 401);
  }

  // Per-run ceiling. Keyed by run id, so an agent that loops does not spend
  // the whole account before the run's own timeout stops it.
  const budget = env.RATE_LIMITER.getByName(`run:${token.runId}`);
  const allowed = await budget.take(
    intVar(env.MODEL_CALLS_PER_RUN, 20),
    // Refill slower than a run can live, so the cap is per run rather than a
    // rate the run could wait out.
    3600,
  );
  if (!allowed.ok) {
    return error(
      "QuotaExceeded",
      `this run has reached its limit of ${intVar(env.MODEL_CALLS_PER_RUN, 20)} model calls`,
      429,
    );
  }

  const upstream = new URL(env.UPSTREAM_BASE);
  // Path is appended rather than substituted, so the caller cannot walk out of
  // the upstream's prefix.
  upstream.pathname = `${upstream.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);
  // Dropped so the upstream sees the proxy, not the container's view of it,
  // and so nothing about the caller is forwarded on.
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  headers.delete("cf-ray");

  const response = await fetch(
    new Request(upstream.toString(), {
      method: request.method,
      headers,
      body: request.body,
      // The engine streams nothing today, but a streamed completion should
      // pass through rather than be buffered by the proxy.
      redirect: "manual",
    }),
  );

  // The upstream's own headers travel back untouched apart from CORS, which is
  // meaningless here: the caller is a container, not a browser.
  return response;
}
