/**
 * The limits the broker advertises on /v1/capabilities.
 *
 * The engine half of this file mirrors what the engine is actually started
 * with: the DEFAULT_* constants in packages/server/src/config.ts, plus the
 * flags Dockerfile.cloudflare passes on the command line. The broker cannot
 * import the server package — this is a Worker bundle, and the server is a
 * Node program — so the values are copied here, in one place, and a server
 * test (packages/server/src/__tests__/cloudflare-capabilities.test.ts)
 * compares them against the originals so a drift fails the build.
 */

// Passed explicitly in Dockerfile.cloudflare's CMD.
export const ENGINE_MAX_ITERATIONS = 25;
export const ENGINE_TIMEOUT_MS = 60_000;

// The engine's defaults: packages/server/src/config.ts DEFAULT_*.
export const ENGINE_MAX_BODY_BYTES = 1024 * 1024;
export const ENGINE_MAX_REQUEST_TOOLS = 10;
export const ENGINE_MAX_REQUEST_PLUGINS = 5;
export const ENGINE_MAX_REQUEST_FILES = 20;
export const ENGINE_MAX_REQUEST_CODE_BYTES = 256 * 1024;

/**
 * Per deployment topology, not a server default: one container instance per
 * run, so a caller never gets more than one run at a time regardless of the
 * --max-concurrent the engine itself would accept.
 */
export const ENGINE_MAX_CONCURRENT_RUNS = 1;

// Broker-side throttles, overridable per deployment via env vars.
export const DEFAULT_RUNS_PER_MINUTE = 6;
export const DEFAULT_MODEL_CALLS_PER_RUN = 20;
