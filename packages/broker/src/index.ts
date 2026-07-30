import { getContainer } from "@cloudflare/containers";
import { corsHeaders, error, json, preflight, withCors } from "./cors";
import { intVar, origins, type Env } from "./env";
import { RUN_TOKEN_HEADER } from "./container";
import { handleLlmProxy } from "./llm-proxy";
import { callerKey } from "./ratelimit";
import { mintToken } from "./token";

export { HeddleEngine } from "./container";
export { RateLimiter } from "./ratelimit";

const TOKEN_TTL_SECONDS = 300;
const SECONDS_PER_MINUTE = 60;
const DEFAULT_RUNS_PER_MINUTE = 6;
const DEFAULT_MODEL_CALLS_PER_RUN = 20;
const LLM_PROXY_PREFIX = "/llm/";
const TRAILING_SLASHES = /\/+$/;
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

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
    const path = url.pathname.replace(TRAILING_SLASHES, "") || "/";

    if (path.startsWith(LLM_PROXY_PREFIX)) {
      return handleLlmProxy(request, env, path.slice(LLM_PROXY_PREFIX.length));
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

    if (path !== "/v1/runs" && path !== "/v1/validate") {
      return error(
        "NotFound",
        `no route for ${request.method} ${path}`,
        404,
        cors,
      );
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

    const throttled = await rateLimit(request, env, cors);
    if (throttled) return throttled;

    return runInContainer(request, env, ctx, cors);
  },
} satisfies ExportedHandler<Env>;

function capabilities(env: Env): Record<string, unknown> {
  return {
    version: "0.2.0-beta.1",
    allowRequestCode: true,
    acceptsFlowPath: false,
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
      runsPerMinute: intVar(env.RUNS_PER_MINUTE, DEFAULT_RUNS_PER_MINUTE),
      modelCallsPerRun: intVar(
        env.MODEL_CALLS_PER_RUN,
        DEFAULT_MODEL_CALLS_PER_RUN,
      ),
    },
    runsInFlight: 0,
    via: "broker",
  };
}

async function turnstileOk(request: Request, env: Env): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) return true;

  const token = request.headers.get("x-turnstile-token");
  if (!token) return false;

  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET);
  body.append("response", token);

  const ip = request.headers.get("cf-connecting-ip");
  if (ip) body.append("remoteip", ip);

  const verify = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body });
  const result = (await verify.json()) as { success?: boolean };

  return result.success === true;
}

async function rateLimit(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response | undefined> {
  const perMinute = intVar(env.RUNS_PER_MINUTE, DEFAULT_RUNS_PER_MINUTE);
  const limiter = env.RATE_LIMITER.getByName(`ip:${callerKey(request)}`);

  const verdict = await limiter.take(
    perMinute,
    SECONDS_PER_MINUTE / perMinute,
  );
  if (verdict.ok) return undefined;

  return error(
    "TooManyRequests",
    `at most ${perMinute} runs a minute. Try again in ${verdict.retryAfter}s.`,
    429,
    { ...cors, "retry-after": String(verdict.retryAfter) },
  );
}

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

  return pipeUntilStreamEnds(response, stub, ctx, cors);
}

function pipeUntilStreamEnds(
  response: Response,
  stub: { destroy: () => Promise<unknown> },
  ctx: ExecutionContext,
  cors: Record<string, string>,
): Response {
  const { readable, writable } = new TransformStream();

  ctx.waitUntil(
    (response.body as ReadableStream)
      .pipeTo(writable)
      .catch(() => {})
      .then(() => stub.destroy())
      .catch((err: unknown) =>
        console.error("failed to destroy container", err),
      ),
  );

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(cors)) headers.set(name, value);

  return new Response(readable, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
