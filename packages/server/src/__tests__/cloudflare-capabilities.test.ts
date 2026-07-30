import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, '..', '..');
const brokerIndex = join(packageRoot, '..', 'broker', 'src', 'index.ts');

function cmdFlag(flag: string): number {
  const dockerfile = readFileSync(join(packageRoot, 'Dockerfile.cloudflare'), 'utf-8');
  const match = new RegExp(`"--${flag}",\\s*\\\\?\\s*"(\\d+)"`).exec(dockerfile);
  expect(match, `Dockerfile.cloudflare no longer passes --${flag}`).not.toBeNull();
  return Number(match![1]);
}

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
    expect(advertised('maxConcurrentRuns')).toBeLessThanOrEqual(cmdFlag('max-concurrent'));
  });
});
