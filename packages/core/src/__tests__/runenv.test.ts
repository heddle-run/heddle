import { describe, it, expect, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoSandboxTuning,
  assertToolsAvailable,
  positiveOption,
  sandboxFromOptions,
  standardRegistry,
  type SandboxOptions,
} from '../runenv.js';
import { PluginRegistry } from '../plugin/registry.js';
import { createScratchWorkspace, removeDir } from '../workspace/index.js';
import type { Workspace } from '../workspace/index.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => removeDir(dir));
  return dir;
}

function options(overrides: Partial<SandboxOptions> = {}): SandboxOptions {
  return { allowRead: [], allowWrite: [], allowEnv: [], ...overrides };
}

describe('assertNoSandboxTuning', () => {
  it.each([
    ['--sandbox', options({ sandbox: 'seatbelt' })],
    ['--allow-read', options({ allowRead: ['/data'] })],
    ['--allow-write', options({ allowWrite: ['/out'] })],
    ['--allow-env', options({ allowEnv: ['PATH'] })],
    ['--deny-net', options({ denyNet: true })],
  ])('refuses %s without --safe, naming the flag', (flag, tuned) => {
    expect(() => assertNoSandboxTuning(tuned)).toThrow(flag);
    expect(() => assertNoSandboxTuning(tuned)).toThrow(/requires --safe/);
  });

  it('names every orphaned flag at once', () => {
    expect(() =>
      assertNoSandboxTuning(options({ denyNet: true, allowEnv: ['HOME'] })),
    ).toThrow(/--allow-env, --deny-net/);
  });

  it('passes when nothing was tuned', () => {
    expect(() => assertNoSandboxTuning(options())).not.toThrow();
  });
});

describe('sandboxFromOptions', () => {
  it('returns no sandbox without --safe', () => {
    expect(sandboxFromOptions(options(), undefined)).toBeUndefined();
  });

  it('refuses tuning flags without --safe', () => {
    expect(() =>
      sandboxFromOptions(options({ denyNet: true }), undefined),
    ).toThrow(/--deny-net requires --safe/);
  });

  it('refuses an unknown backend, listing the valid ones', () => {
    const make = () =>
      sandboxFromOptions(options({ safe: true, sandbox: 'firecracker' }), undefined);

    expect(make).toThrow(/unknown sandbox backend "firecracker"/);
    expect(make).toThrow(/auto, bubblewrap, seatbelt/);
  });

  it.runIf(process.platform === 'darwin')(
    'grants a named workspace directory write without an extra flag',
    () => {
      const workDir = tempDir('heddle-workdir-');
      const sandbox = sandboxFromOptions(
        options({ safe: true, sandbox: 'seatbelt', workspace: workDir }),
        undefined,
      );

      const ws: Workspace = createScratchWorkspace('runenv-test');
      cleanups.push(() => ws.dispose());
      const cmd = sandbox!.session('runenv-test', ws).wrap(process.execPath);
      cleanups.push(() => cmd.cleanup?.());

      const profile = cmd.args[cmd.args.indexOf('-p') + 1];
      const writeRule = profile
        .split('\n')
        .find((line) => line.startsWith('(allow file-read* file-write*'));
      expect(writeRule).toContain(`(subpath "${workDir}")`);
    },
  );
});

describe('positiveOption', () => {
  it('returns the fallback when the flag was not given', () => {
    expect(positiveOption('--mount-max-bytes', undefined, 42)).toBe(42);
  });

  it('parses a positive whole number', () => {
    expect(positiveOption('--mount-max-bytes', '7', 42)).toBe(7);
  });

  it.each(['0', '-3', '2.5', 'abc', ''])(
    'rejects "%s", naming the flag',
    (raw) => {
      const parse = () => positiveOption('--mount-max-entries', raw, 42);

      expect(parse).toThrow('--mount-max-entries');
      expect(parse).toThrow(new RegExp(`got "${raw}"`));
    },
  );
});

describe('standardRegistry and assertToolsAvailable', () => {
  function registryWith(...tools: string[]) {
    const dir = tempDir('heddle-tools-');
    for (const tool of tools) {
      const path = join(dir, tool);
      writeFileSync(path, '#!/bin/sh\n');
      chmodSync(path, 0o755);
    }
    return standardRegistry({ plugins: PluginRegistry.empty(), toolsDir: dir });
  }

  it('resolves tools from the operator directory', () => {
    const registry = registryWith('summarize');

    expect(registry.lookup('summarize')).toBeDefined();
    expect(() => assertToolsAvailable(registry, ['summarize'])).not.toThrow();
  });

  it('lists every missing tool by name', () => {
    const check = () =>
      assertToolsAvailable(registryWith('summarize'), [
        'summarize',
        'ghost',
        'phantom',
      ]);

    expect(check).toThrow(/missing executables for tools: ghost, phantom/);
  });
});
