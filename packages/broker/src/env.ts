import type { HeddleEngine } from "./container";
import type { RateLimiter } from "./ratelimit";

export interface Env {
  ENGINE: DurableObjectNamespace<HeddleEngine>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  ALLOWED_ORIGINS: string;
  PROXY_HOST: string;
  PROXY_URL: string;
  UPSTREAM_BASE: string;

  RUNS_PER_MINUTE: string;
  MODEL_CALLS_PER_RUN: string;

  RUN_TOKEN_SECRET: string;
  OPENAI_API_KEY: string;
  TURNSTILE_SECRET?: string;
}

export function intVar(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function origins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
