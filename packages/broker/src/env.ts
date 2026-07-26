import type { HeddleEngine } from "./container";
import type { RateLimiter } from "./ratelimit";

export interface Env {
  ENGINE: DurableObjectNamespace<HeddleEngine>;
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>;

  // --- vars (wrangler.jsonc) ----------------------------------------------
  /** Comma-separated browser origins allowed to call the broker. */
  ALLOWED_ORIGINS: string;
  /** The broker's own hostname. The one host a container may reach. */
  PROXY_HOST: string;
  /** Absolute URL of the model proxy, handed to the engine as OPENAI_BASE_URL. */
  PROXY_URL: string;
  /** Upstream the model proxy forwards to. */
  UPSTREAM_BASE: string;

  /** Runs per caller per minute. */
  RUNS_PER_MINUTE: string;
  /** Model calls one run may make before the proxy refuses it. */
  MODEL_CALLS_PER_RUN: string;

  // --- secrets (wrangler secret put) --------------------------------------
  /** HMAC key for run tokens. */
  RUN_TOKEN_SECRET: string;
  /**
   * The real model credential. Lives here and only here — never in a
   * container, where a five-line flow could read it out of the environment.
   */
  OPENAI_API_KEY: string;
  /** Optional. When set, requests must carry a solved Turnstile token. */
  TURNSTILE_SECRET?: string;
}

/** Read an integer var, falling back when it is unset or malformed. */
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
