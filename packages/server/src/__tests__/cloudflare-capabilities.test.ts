import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ENGINE_MAX_BODY_BYTES,
  ENGINE_MAX_CONCURRENT_RUNS,
  ENGINE_MAX_ITERATIONS,
  ENGINE_MAX_REQUEST_CODE_BYTES,
  ENGINE_MAX_REQUEST_FILES,
  ENGINE_MAX_REQUEST_PLUGINS,
  ENGINE_MAX_REQUEST_TOOLS,
  ENGINE_TIMEOUT_MS,
} from '../../../broker/src/constants.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REQUEST_CODE_BYTES,
  DEFAULT_MAX_REQUEST_FILES,
  DEFAULT_MAX_REQUEST_PLUGINS,
  DEFAULT_MAX_REQUEST_TOOLS,
} from '../config.js';

/**
 * The playground broker advertises the engine's limits without being able to
 * import this package — it is a Worker bundle — so it keeps copies in
 * packages/broker/src/constants.ts. These tests are what keeps the copies
 * honest: against this package's defaults for the limits the engine is not
 * started with flags for, and against Dockerfile.cloudflare's CMD for the ones
 * it is.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');

function cmdFlag(flag: string): number {
  const dockerfile = readFileSync(
    join(packageRoot, 'Dockerfile.cloudflare'),
    'utf-8',
  );
  // One logical line, however the CMD is wrapped in the file.
  const unwrapped = dockerfile.replace(/\\\r?\n/g, ' ');
  const match = new RegExp(`"--${flag}"\\s*,\\s*"(\\d+)"`).exec(unwrapped);
  expect(match, `Dockerfile.cloudflare no longer passes --${flag}`).not.toBeNull();
  return Number(match![1]);
}

describe('what the playground advertises', () => {
  it('matches the run budget the engine is started with', () => {
    expect(ENGINE_TIMEOUT_MS).toBe(cmdFlag('timeout'));
  });

  it('matches the iteration ceiling the engine is started with', () => {
    expect(ENGINE_MAX_ITERATIONS).toBe(cmdFlag('max-iterations'));
  });

  it('never promises more concurrency than the engine would accept', () => {
    expect(ENGINE_MAX_CONCURRENT_RUNS).toBeLessThanOrEqual(
      cmdFlag('max-concurrent'),
    );
  });

  it('matches the request-shape defaults the engine runs with', () => {
    // No flags in the Dockerfile for these, so the engine runs the defaults.
    expect(ENGINE_MAX_BODY_BYTES).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(ENGINE_MAX_REQUEST_TOOLS).toBe(DEFAULT_MAX_REQUEST_TOOLS);
    expect(ENGINE_MAX_REQUEST_PLUGINS).toBe(DEFAULT_MAX_REQUEST_PLUGINS);
    expect(ENGINE_MAX_REQUEST_FILES).toBe(DEFAULT_MAX_REQUEST_FILES);
    expect(ENGINE_MAX_REQUEST_CODE_BYTES).toBe(DEFAULT_MAX_REQUEST_CODE_BYTES);
  });

  it('starts the engine with bundles refused', () => {
    // Bundles run with the server's full rights, and this engine serves
    // anonymous internet callers — the exact deployment --no-bundles is for.
    // ENGINE_MAX_BODY_BYTES above also depends on this: with bundles on, the
    // run route's body cap would rise past what the broker advertises.
    const dockerfile = readFileSync(
      join(packageRoot, 'Dockerfile.cloudflare'),
      'utf-8',
    );
    const unwrapped = dockerfile.replace(/\\\r?\n/g, ' ');
    expect(unwrapped).toMatch(/"--no-bundles"/);
  });
});
