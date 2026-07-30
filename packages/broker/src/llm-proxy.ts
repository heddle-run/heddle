import { intVar, type Env } from "./env";
import { error } from "./cors";
import { verifyToken } from "./token";

const DEFAULT_MODEL_CALLS_PER_RUN = 20;
const RUN_BUDGET_REFILL_SECONDS = 3600;
const BEARER_PREFIX = /^Bearer\s+/i;
const TRAILING_SLASHES = /\/+$/;
const LEADING_SLASHES = /^\/+/;

const CALLER_HEADERS = ["host", "cf-connecting-ip", "x-forwarded-for", "cf-ray"];

export async function handleLlmProxy(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const presented = (request.headers.get("authorization") ?? "")
    .replace(BEARER_PREFIX, "")
    .trim();
  if (!presented) {
    return error("Unauthorized", "no run token presented", 401);
  }

  const token = await verifyToken(env.RUN_TOKEN_SECRET, presented);
  if (!token) {
    return error("Unauthorized", "run token is not valid", 401);
  }

  const exhausted = await spendRunBudget(env, token.runId);
  if (exhausted) return exhausted;

  return fetch(
    new Request(upstreamUrl(env, path), {
      method: request.method,
      headers: upstreamHeaders(request, env),
      body: request.body,
      redirect: "manual",
    }),
  );
}

async function spendRunBudget(
  env: Env,
  runId: string,
): Promise<Response | undefined> {
  const limit = intVar(env.MODEL_CALLS_PER_RUN, DEFAULT_MODEL_CALLS_PER_RUN);
  const budget = env.RATE_LIMITER.getByName(`run:${runId}`);

  const allowed = await budget.take(limit, RUN_BUDGET_REFILL_SECONDS);
  if (allowed.ok) return undefined;

  return error(
    "QuotaExceeded",
    `this run has reached its limit of ${limit} model calls`,
    429,
  );
}

function upstreamUrl(env: Env, path: string): string {
  const upstream = new URL(env.UPSTREAM_BASE);
  const base = upstream.pathname.replace(TRAILING_SLASHES, "");
  upstream.pathname = `${base}/${path.replace(LEADING_SLASHES, "")}`;

  return upstream.toString();
}

function upstreamHeaders(request: Request, env: Env): Headers {
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);

  for (const name of CALLER_HEADERS) headers.delete(name);

  return headers;
}
