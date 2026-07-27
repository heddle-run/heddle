/**
 * The playground's advertised limits and the image that enforces them.
 *
 * The broker answers `/v1/capabilities` from a literal rather than from the
 * engine, because probing a container would cost a cold start per page load.
 * That literal is a copy of `Dockerfile.cloudflare`'s CMD, and the two have
 * already drifted once — the CMD's `--max-concurrent` said 8 while its own
 * comment described many runs per instance and the broker advertised 1.
 *
 * Both files live outside this package's `src`, and neither is importable here:
 * the Dockerfile is not code, and the broker is a Worker module. They are read
 * as text, which is enough — the failure being prevented is a number changing
 * in one place and not the other.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const brokerIndex = join(packageRoot, '..', 'broker', 'src', 'index.ts');

/** A `--flag value` pair from the CMD array in Dockerfile.cloudflare. */
function cmdFlag(flag: string): number {
  const dockerfile = readFileSync(join(packageRoot, 'Dockerfile.cloudflare'), 'utf-8');
  const match = new RegExp(`"--${flag}",\\s*\\\\?\\s*"(\\d+)"`).exec(dockerfile);
  expect(match, `Dockerfile.cloudflare no longer passes --${flag}`).not.toBeNull();
  return Number(match![1]);
}

/** A numeric entry from the broker's hardcoded capabilities literal. */
function advertised(key: string): number {
  const source = readFileSync(brokerIndex, 'utf-8');
  const match = new RegExp(`${key}:\\s*([\\d_]+)`).exec(source);
  expect(match, `the broker no longer advertises ${key}`).not.toBeNull();
  return Number(match![1].replace(/_/g, ''));
}

describe('what the playground advertises', () => {
  it('matches the run budget the engine is started with', () => {
    expect(advertised('timeout')).toBe(cmdFlag('timeout'));
  });

  it('matches the iteration ceiling the engine is started with', () => {
    expect(advertised('maxIterations')).toBe(cmdFlag('max-iterations'));
  });

  it('never promises more concurrency than the engine would accept', () => {
    // Not equality. The engine's flag is a ceiling that this topology never
    // approaches: the broker addresses an engine by run id and destroys it with
    // the run, so one instance serves one caller whatever the flag says. What
    // must not happen is the advertised figure climbing above what the engine
    // would actually serve.
    expect(advertised('maxConcurrentRuns')).toBeLessThanOrEqual(cmdFlag('max-concurrent'));
  });
});
