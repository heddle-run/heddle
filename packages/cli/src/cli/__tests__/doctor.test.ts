import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from 'commander';
import { bundleCommand } from '../bundle.js';
import { doctorCommand } from '../doctor.js';
import { runCommand } from '../run.js';

const repoRoot = join(import.meta.dirname, '../../../../../');
const FLOW = join(repoRoot, 'examples/ag-ui/flow.json');

let dir: string;
let exitCode: typeof process.exitCode;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'heddle-cli-doctor-'));
  exitCode = process.exitCode;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  // Restored, or one failing check here would decide the exit status of the
  // whole test run.
  process.exitCode = exitCode;
});

interface Captured {
  stdout: string;
  stderr: string;
  code: typeof process.exitCode;
}

async function invoke(command: Command, args: string[]): Promise<Captured> {
  let stdout = '';
  let stderr = '';

  const spies = [
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      stdout += `${line}\n`;
    }),
    vi.spyOn(console, 'error').mockImplementation((line: string) => {
      stderr += `${line}\n`;
    }),
  ];

  process.exitCode = undefined;
  try {
    await command.parseAsync(args, { from: 'user' });
    return { stdout, stderr, code: process.exitCode };
  } finally {
    process.exitCode = undefined;
    for (const spy of spies) spy.mockRestore();
  }
}

/** What the packed flow answers with, so a run that happened is visible. */
const RAN = 'the-run-started';

/** A bundle of the example flow, carrying whatever `--requires` says. */
async function pack(requires?: string): Promise<string> {
  const out = join(dir, 'demo.heddle');
  await invoke(bundleCommand, [
    FLOW,
    '--input',
    JSON.stringify({ query: RAN }),
    '-o',
    out,
    ...(requires ? ['--requires', requires] : []),
  ]);
  return out;
}

/** A requirement naming something this machine certainly does not have. */
const ABSENT = '[{"binary":"heddle-absent-tool-6f2a","hint":"install nothing"}]';

/** One that holds anywhere: node is running this test. */
const PRESENT = '[{"node":">=1"}]';

describe('heddle doctor', () => {
  it('exits 0 and summarizes when every requirement holds', async () => {
    const { stdout, code } = await invoke(doctorCommand, [await pack(PRESENT)]);

    expect(code).toBeUndefined();
    expect(stdout).toContain('1 requirement, all met');
    expect(stdout).toContain(`✓ node v${process.versions.node}`);
  });

  it('exits non-zero and names what is missing', async () => {
    const { stdout, code } = await invoke(doctorCommand, [await pack(ABSENT)]);

    expect(code).toBe(1);
    expect(stdout).toContain('cannot run here — 1 requirement unmet');
    expect(stdout).toContain('heddle-absent-tool-6f2a');
    expect(stdout).toContain('not on PATH');
    expect(stdout).toContain('install nothing');
  });

  it('says so, and exits 0, when a bundle declares nothing', async () => {
    const { stdout, code } = await invoke(doctorCommand, [await pack()]);

    expect(code).toBeUndefined();
    expect(stdout).toContain('declares no requirements');
  });

  it('says a flow file had nowhere to declare anything', async () => {
    const { stdout, code } = await invoke(doctorCommand, [FLOW]);

    expect(code).toBeUndefined();
    expect(stdout).toContain('nowhere to record requirements');
  });

  it('checks a list against a flow that is not packed yet', async () => {
    const { stdout, code } = await invoke(doctorCommand, [
      FLOW,
      '--requires',
      ABSENT,
    ]);

    expect(code).toBe(1);
    expect(stdout).toContain('flow.json cannot run here');
  });

  it('reads a list from a file', async () => {
    const path = join(dir, 'requires.json');
    writeFileSync(path, ABSENT);

    const { code } = await invoke(doctorCommand, [FLOW, '--requires', `@${path}`]);
    expect(code).toBe(1);
  });

  it('refuses to check a list other than the one the bundle carries', async () => {
    const bundle = await pack(PRESENT);

    await expect(
      invoke(doctorCommand, [bundle, '--requires', ABSENT]),
    ).rejects.toThrow(/records its own requirements/);
  });
});

describe('heddle run <bundle> with requirements', () => {
  it('refuses before anything starts, listing what is missing', async () => {
    const bundle = await pack(ABSENT);

    await expect(invoke(runCommand, [bundle])).rejects.toThrow(
      /cannot run here — 1 requirement unmet/,
    );
  });

  it('runs when they hold', async () => {
    const bundle = await pack(PRESENT);

    const stdout = await captureStdout(() => invoke(runCommand, [bundle]));
    expect(stdout).toContain(RAN);
  });

  it('runs a bundle that declares nothing, as it always did', async () => {
    const bundle = await pack();

    const stdout = await captureStdout(() => invoke(runCommand, [bundle]));
    expect(stdout).toContain(RAN);
  });

  it('starts anyway with --no-preflight', async () => {
    const bundle = await pack(ABSENT);

    const stdout = await captureStdout(() =>
      invoke(runCommand, [bundle, '--no-preflight']),
    );
    expect(stdout).toContain(RAN);
  });

  it('finds a binary the bundle asked for on PATH', async () => {
    const binDir = join(dir, 'bin');
    mkdirSync(binDir);
    const tool = join(binDir, 'heddle-fake-tool');
    writeFileSync(tool, '#!/bin/sh\n');
    chmodSync(tool, 0o755);

    const bundle = await pack('[{"binary":"heddle-fake-tool"}]');
    const previous = process.env.PATH;
    process.env.PATH = `${binDir}:${previous ?? ''}`;
    try {
      const stdout = await captureStdout(() => invoke(runCommand, [bundle]));
      expect(stdout).toContain(RAN);
    } finally {
      process.env.PATH = previous;
    }
  });
});

/** `run` prints the final state with `console.log`, which `invoke` collects. */
async function captureStdout(run: () => Promise<Captured>): Promise<string> {
  const { stdout } = await run();
  return stdout;
}
