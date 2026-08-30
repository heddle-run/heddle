import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The engine artifact the Swift package ships is a checked-in copy of what
 * `scripts/build-portable.mjs` produces — checked in so `swift build` needs
 * no Node toolchain. A copy can go stale, and a stale copy is an iOS app
 * running last month's engine while every test here watches this month's.
 * This test is the freshness gate: rebuild, diff, and name the fix.
 */
describe('the checked-in engine artifact', () => {
  const core = resolve(__dirname, '../..');
  const resource = resolve(
    core,
    '../../apps/HeddleCore/Sources/HeddleCore/EngineResources/heddle-engine.js',
  );

  it.skipIf(!existsSync(resource))('matches a fresh portable build', () => {
    execFileSync(process.execPath, [join(core, 'scripts/build-portable.mjs')], {
      cwd: core,
      stdio: 'pipe',
    });

    const built = readFileSync(join(core, 'dist/portable/heddle-engine.js'), 'utf-8');
    const shipped = readFileSync(resource, 'utf-8');

    expect(
      shipped === built,
      'apps/HeddleCore ships a stale heddle-engine.js — run scripts/update-engine-artifact.sh',
    ).toBe(true);
  });
});
