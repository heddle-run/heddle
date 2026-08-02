import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeatbeltSandbox } from '../seatbelt.js';
import { DEFAULT_SANDBOX_POLICY } from '../types.js';
import type { SandboxCommand, SandboxPolicy, SandboxSession } from '../types.js';
import { createScratchWorkspace, removeDir, RESERVED_DIR } from '../../workspace/index.js';
import type { Workspace } from '../../workspace/index.js';

/**
 * These tests read the SBPL profile and argv `wrap` builds — pure text
 * generation, so they run anywhere. Whether macOS enforces the profile is
 * enforcement.test.ts's job.
 *
 * Real paths throughout: the backend realpath-resolves every path it grants,
 * so a made-up `/tools/echo` would not land in the profile as written.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix = 'seatbelt-test-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => removeDir(dir));
  return dir;
}

// Shared by every test, so made outside tempDir's per-test cleanup.
const launchDir = realpathSync(mkdtempSync(join(tmpdir(), 'seatbelt-launch-')));

function tool(): string {
  const path = join(tempDir('seatbelt-tools-'), 'echo-tool');
  writeFileSync(path, '#!/bin/sh\n');
  chmodSync(path, 0o755);
  return path;
}

function workspace(label = 'test-agent'): Workspace {
  const created = createScratchWorkspace(label);
  cleanups.push(() => created.dispose());
  return created;
}

function session(
  overrides: Partial<SandboxPolicy> = {},
  ws: Workspace = workspace(),
): SandboxSession {
  const policy: SandboxPolicy = {
    ...DEFAULT_SANDBOX_POLICY,
    cwd: launchDir,
    ...overrides,
  };
  return new SeatbeltSandbox(policy).session('test-agent', ws);
}

function wrap(
  overrides: Partial<SandboxPolicy> = {},
  ws?: Workspace,
): SandboxCommand {
  const cmd = session(overrides, ws).wrap(tool());
  cleanups.push(() => cmd.cleanup?.());
  return cmd;
}

function profileOf(cmd: SandboxCommand): string {
  expect(cmd.args[0]).toBe('-p');
  return cmd.args[1];
}

function ruleLine(profile: string, prefix: string): string | undefined {
  return profile.split('\n').find((line) => line.startsWith(prefix));
}

const readRule = (profile: string) => ruleLine(profile, '(allow file-read* (literal "/")');
const writeRule = (profile: string) => ruleLine(profile, '(allow file-read* file-write*');

describe('SeatbeltSandbox', () => {
  it('invokes the tool through sandbox-exec with an inline profile', () => {
    const path = tool();
    const cmd = session().wrap(path, ['--flag']);
    cleanups.push(() => cmd.cleanup?.());

    expect(cmd.command).toBe('/usr/bin/sandbox-exec');
    expect(cmd.args[0]).toBe('-p');
    expect(cmd.args[2]).toBe(path);
    expect(cmd.args[3]).toBe('--flag');
  });

  it('denies by default, before any allow', () => {
    const lines = profileOf(wrap()).split('\n');

    expect(lines[0]).toBe('(version 1)');
    expect(lines[1]).toBe('(deny default)');
    expect(lines.slice(2).some((line) => line.startsWith('(deny default)'))).toBe(false);
  });

  it('grants system paths read-only and never grants $HOME', () => {
    const profile = profileOf(wrap());

    expect(readRule(profile)).toContain('(subpath "/usr")');
    expect(writeRule(profile)).not.toContain('(subpath "/usr")');
    expect(profile).not.toContain(process.env.HOME ?? '/home/nobody');
  });

  it('puts policy read paths in the read rule, not the write rule', () => {
    const readable = tempDir();
    const profile = profileOf(wrap({ readPaths: [readable] }));

    expect(readRule(profile)).toContain(`(subpath "${readable}")`);
    expect(writeRule(profile)).not.toContain(`(subpath "${readable}")`);
  });

  it('keeps the directory heddle was launched from readable, and read-only', () => {
    const profile = profileOf(wrap());

    expect(readRule(profile)).toContain(`(subpath "${launchDir}")`);
    expect(writeRule(profile)).not.toContain(`(subpath "${launchDir}")`);
  });

  it('puts policy write paths in the write rule', () => {
    const writable = tempDir();
    const profile = profileOf(wrap({ writePaths: [writable] }));

    expect(writeRule(profile)).toContain(`(subpath "${writable}")`);
  });

  it('never widens a missing path into an ancestor that exists', () => {
    // A typo'd --allow-write must grant the typo, not the nearest real
    // directory — and never "/", which is what a fully absent ancestry
    // once resolved to.
    const parent = tempDir();
    const missing = join(parent, 'not', 'created');
    const rootless = `/heddle-does-not-exist-${process.pid}`;
    const profile = profileOf(wrap({ writePaths: [missing, rootless] }));

    expect(writeRule(profile)).toContain(`(subpath "${missing}")`);
    expect(writeRule(profile)).not.toContain(`(subpath "${parent}")`);
    expect(writeRule(profile)).toContain(`(subpath "${rootless}")`);
    expect(writeRule(profile)).not.toContain('(subpath "/")');
  });

  it('denies the network only when the policy denies it', () => {
    const open = profileOf(wrap({ network: true }));
    const closed = profileOf(wrap({ network: false }));

    expect(open).toContain('(allow network*)');
    expect(open).not.toContain('(deny network*)');
    expect(closed).toContain('(deny network*)');
    expect(closed).not.toContain('(allow network*)');
  });

  it('drops parent environment variables that the policy does not name', () => {
    process.env.HEDDLE_TEST_SECRET = 'super-secret';
    process.env.HEDDLE_TEST_ALLOWED = 'fine';
    try {
      const cmd = wrap({ passEnv: ['HEDDLE_TEST_ALLOWED'] });

      expect(cmd.env.HEDDLE_TEST_SECRET).toBeUndefined();
      expect(cmd.env.HEDDLE_TEST_ALLOWED).toBe('fine');
      expect(cmd.args.join(' ')).not.toContain('super-secret');
    } finally {
      delete process.env.HEDDLE_TEST_SECRET;
      delete process.env.HEDDLE_TEST_ALLOWED;
    }
  });

  it('points HOME and TMPDIR at a per-invocation scratch, writable and removed on cleanup', () => {
    const cmd = session().wrap(tool());

    const scratch = cmd.env.TMPDIR;
    expect(cmd.env.HOME).toBe(join(scratch, 'home'));
    expect(cmd.env.HOME).not.toBe(process.env.HOME);
    expect(writeRule(profileOf(cmd))).toContain(`(subpath "${scratch}")`);

    expect(existsSync(cmd.env.HOME)).toBe(true);
    cmd.cleanup?.();
    expect(existsSync(scratch)).toBe(false);
  });
});

/** The seatbelt half of what the bubblewrap suite checks about sessions. */
describe('seatbelt sessions', () => {
  it('starts the tool in the workspace and grants it write', () => {
    const ws = workspace();
    const cmd = wrap({}, ws);

    expect(cmd.cwd).toBe(ws.root);
    expect(cmd.env.HEDDLE_WORKSPACE).toBe(ws.root);
    expect(writeRule(profileOf(cmd))).toContain(`(subpath "${ws.root}")`);
  });

  it('grants a session only the workspace it was given', () => {
    const a = workspace();
    const b = workspace();

    expect(a.root).not.toBe(b.root);
    expect(profileOf(wrap({}, a))).not.toContain(b.root);
  });

  it('denies writes to the reserved directory after the workspace allow', () => {
    const ws = workspace();
    const lines = profileOf(wrap({}, ws)).split('\n');

    const allow = lines.findIndex(
      (line) => writeRule(line) !== undefined && line.includes(`(subpath "${ws.root}")`),
    );
    const deny = lines.findIndex(
      (line) =>
        line.startsWith('(deny file-write*') &&
        line.includes(`(subpath "${join(ws.root, RESERVED_DIR)}")`),
    );

    expect(allow).toBeGreaterThan(-1);
    // After, or the profile's last-match rule hands the reserved dir back.
    expect(deny).toBeGreaterThan(allow);
  });

  it('puts the workspace bin on PATH', () => {
    const ws = workspace();
    const cmd = wrap({}, ws);

    expect(cmd.env.HEDDLE_WORKSPACE_BIN).toBe(ws.bin);
    expect(cmd.env.PATH.endsWith(`:${ws.bin}`)).toBe(true);
  });

  it('leaves the workspace alone when the session is disposed', () => {
    const ws = workspace();
    session({}, ws).dispose();

    expect(existsSync(ws.root)).toBe(true);
  });
});
