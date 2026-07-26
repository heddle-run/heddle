/**
 * The broker: the only public face of the heddle playground.
 *
 * The engine behind it executes code its callers wrote, so this worker owns
 * every question the engine deliberately does not answer — who is calling, how
 * often they may, and what the thing they start is allowed to reach. The
 * engine's own README is blunt that it has no authentication; this is where
 * that is supposed to be terminated.
 *
 * Runs get a container of their own, addressed by run id, destroyed when the
 * response stream closes.
 */
import { getContainer } from "@cloudflare/containers";
import { corsHeaders, error, json, preflight, withCors } from "./cors";
import { intVar, origins, type Env } from "./env";
import { RUN_TOKEN_HEADER } from "./container";
import { handleLlmProxy } from "./llm-proxy";
import { callerKey } from "./ratelimit";
import { mintToken } from "./token";

export { HeddleEngine } from "./container";
export { RateLimiter } from "./ratelimit";

/** How long a run's proxy credential stays valid. */
const TOKEN_TTL_SECONDS = 300;

/**
 * What this deployment permits, answered by the broker rather than the engine.
 *
 * Starting a container to answer a capabilities probe would mean a cold start
 * on every page load, for a response that is a property of the deployment and
 * not of any instance. It mirrors the CMD in Dockerfile.cloudflare — keep the
 * two in step.
 */
function capabilities(env: Env): Record<string, unknown> {
  return {
    version: "0.2.0-beta.1",
    allowRequestCode: true,
    acceptsFlowPath: false,
    // No bubblewrap on this platform: it needs user namespaces the runtime
    // does not grant. The container is the boundary instead.
    sandbox: null,
    tools: [],
    limits: {
      maxIterations: 25,
      timeout: 60_000,
      maxBodyBytes: 1024 * 1024,
      maxRequestTools: 10,
      maxRequestPlugins: 5,
      maxRequestCodeBytes: 256 * 1024,
      maxConcurrentRuns: 1,
      runsPerMinute: intVar(env.RUNS_PER_MINUTE, 6),
      modelCallsPerRun: intVar(env.MODEL_CALLS_PER_RUN, 20),
    },
    runsInFlight: 0,
    via: "broker",
  };
}

/**
 * Turnstile, when configured. Absent a secret this is a no-op, and the rate
 * limiter is the only thing between the internet and the engine — workable for
 * a playground, but the weaker of the two arrangements.
 */
async function turnstileOk(request: Request, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;

  const token = request.headers.get("x-turnstile-token");
  if (!token) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) body.append("remoteip", ip);

  const verify = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  const result = (await verify.json()) as { success?: boolean };
  return result.success === true;
}

/**
 * Run one request against a container of its own.
 *
 * The container is destroyed once the response body finishes, which for a
 * streamed run is when the last event has been written. `sleepAfter` on the
 * class is the backstop for the paths this does not see.
 */
async function runInContainer(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  cors: Record<string, string>,
): Promise<Response> {
  const runId = crypto.randomUUID();
  const token = await mintToken(env.RUN_TOKEN_SECRET, runId, TOKEN_TTL_SECONDS);

  const stub = getContainer(env.ENGINE, runId);

  const forwarded = new Request(request);
  forwarded.headers.set(RUN_TOKEN_HEADER, token);

  let response: Response;
  try {
    response = await stub.fetch(forwarded);
  } catch (err) {
    console.error("engine unreachable", err);
    return error(
      "EngineUnavailable",
      "could not start an engine for this run. Try again shortly.",
      502,
      cors,
    );
  }

  if (!response.body) {
    ctx.waitUntil(stub.destroy().catch(() => {}));
    return withCors(response, cors);
  }

  // Pipe rather than return the body directly, so the container's life can be
  // tied to the stream's rather than to this handler's.
  const { readable, writable } = new TransformStream();
  ctx.waitUntil(
    response.body
      .pipeTo(writable)
      .catch(() => {
        // A caller that hangs up mid-stream is ordinary. The container is torn
        // down either way, which is the point of the finally below.
      })
      .then(() => stub.destroy())
      .catch((err: unknown) => console.error("failed to destroy container", err)),
  );

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const allowed = origins(env);
    const early = preflight(request, allowed);
    if (early) return early;

    const cors = corsHeaders(request, allowed);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // The model proxy is called by containers, not browsers, and authenticates
    // with a run token rather than the caller's identity. It is checked first
    // so it never reaches the per-IP limiter — every container shares the
    // worker's view of the network.
    if (path.startsWith("/llm/")) {
      return handleLlmProxy(request, env, path.slice("/llm/".length));
    }

    if (request.method === "GET" && (path === "/healthz" || path === "/")) {
      return json({ status: "ok", role: "broker" }, 200, cors);
    }

    if (path === "/v1/capabilities") {
      if (request.method !== "GET") {
        return error("MethodNotAllowed", "use GET", 405, cors);
      }
      return json(capabilities(env), 200, cors);
    }

    const isRun = path === "/v1/runs";
    const isValidate = path === "/v1/validate";
    if (!isRun && !isValidate) {
      return error("NotFound", `no route for ${request.method} ${path}`, 404, cors);
    }
    if (request.method !== "POST") {
      return error("MethodNotAllowed", "use POST", 405, cors);
    }

    if (!(await turnstileOk(request, env))) {
      return error(
        "ChallengeRequired",
        "this request needs a solved challenge",
        403,
        cors,
      );
    }

    // Both routes start a container, so both are metered. Validation compiles
    // the flow, and compiling calls a submitted plugin's createExecutor — it is
    // no cheaper or safer than a run.
    const limiter = env.RATE_LIMITER.getByName(`ip:${callerKey(request)}`);
    const perMinute = intVar(env.RUNS_PER_MINUTE, 6);
    const verdict = await limiter.take(perMinute, 60 / perMinute);
    if (!verdict.ok) {
      return error(
        "TooManyRequests",
        `at most ${perMinute} runs a minute. Try again in ${verdict.retryAfter}s.`,
        429,
        { ...cors, "retry-after": String(verdict.retryAfter) },
      );
    }

    return runInContainer(request, env, ctx, cors);
  },
} satisfies ExportedHandler<Env>;
