import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { BubblewrapSandbox } from '../bubblewrap.js';
import { DEFAULT_SANDBOX_POLICY } from '../types.js';
import type { SandboxPolicy, SandboxSession } from '../types.js';

const opened: SandboxSession[] = [];

afterEach(() => {
  while (opened.length) opened.pop()!.dispose();
});

/** Opens a bubblewrap session that the suite disposes after each test. */
function session(overrides: Partial<SandboxPolicy> = {}): SandboxSession {
  const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, cwd: '/work', ...overrides };
  const s = new BubblewrapSandbox(policy).session('test-agent');
  opened.push(s);
  return s;
}

/** Index of the first occurrence of a flag/value pair in an argv array. */
function pairIndex(args: string[], flag: string, value: string): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) return i;
  }
  return -1;
}

describe('BubblewrapSandbox', () => {
  it('invokes the tool through bwrap', () => {
    const cmd = session().wrap('/tools/echo');

    expect(cmd.command).toBe('bwrap');
    expect(cmd.args[cmd.args.length - 1]).toBe('/tools/echo');
    expect(cmd.args[cmd.args.length - 2]).toBe('--');
  });

  it('binds system paths read-only and never binds $HOME', () => {
    const joined = session().wrap('/tools/echo').args.join(' ');

    expect(joined).toContain('--ro-bind /usr /usr');
    expect(joined).not.toContain('--bind /usr');
    expect(joined).not.toContain(process.env.HOME ?? '/home/nobody');
  });

  it('keeps the working directory read-only by default', () => {
    const cmd = session().wrap('/tools/echo');

    expect(pairIndex(cmd.args, '--ro-bind-try', '/work')).toBeGreaterThan(-1);
    expect(pairIndex(cmd.args, '--bind-try', '/work')).toBe(-1);
  });

  it('applies write binds after read binds so nesting resolves to writable', () => {
    const cmd = session({ writePaths: ['/work/out'] }).wrap('/tools/echo');

    const read = pairIndex(cmd.args, '--ro-bind-try', '/work');
    const write = pairIndex(cmd.args, '--bind-try', '/work/out');
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(read);
  });

  it('unshares the network only when the policy denies it', () => {
    expect(session({ network: true }).wrap('/t').args).not.toContain('--unshare-net');
    expect(session({ network: false }).wrap('/t').args).toContain('--unshare-net');
  });

  it('drops parent environment variables that the policy does not name', () => {
    process.env.HEDDLE_TEST_SECRET = 'super-secret';
    process.env.HEDDLE_TEST_ALLOWED = 'fine';
    try {
      const cmd = session({ passEnv: ['HEDDLE_TEST_ALLOWED'] }).wrap('/tools/echo');

      expect(cmd.args).toContain('--clearenv');
      expect(cmd.env.HEDDLE_TEST_SECRET).toBeUndefined();
      expect(cmd.args.join(' ')).not.toContain('super-secret');
      expect(cmd.env.HEDDLE_TEST_ALLOWED).toBe('fine');
    } finally {
      delete process.env.HEDDLE_TEST_SECRET;
      delete process.env.HEDDLE_TEST_ALLOWED;
    }
  });

  it('points HOME and TMPDIR at per-invocation paths', () => {
    const cmd = session().wrap('/tools/echo');

    expect(cmd.env.TMPDIR).toBe('/tmp');
    expect(cmd.env.HOME).toBe('/tmp/home');
    expect(cmd.args.join(' ')).toContain('--tmpfs /tmp --dir /tmp/home');
  });
});

describe('bubblewrap sessions', () => {
  it('binds one writable workspace shared by every tool in the session', () => {
    const s = session();
    const first = s.wrap('/tools/a');
    const second = s.wrap('/tools/b');

    expect(first.env.HEDDLE_WORKSPACE).toBe(s.workspace);
    expect(second.env.HEDDLE_WORKSPACE).toBe(s.workspace);
    expect(pairIndex(first.args, '--bind', s.workspace)).toBeGreaterThan(-1);
    expect(pairIndex(second.args, '--bind', s.workspace)).toBeGreaterThan(-1);
  });

  it('gives separate sessions separate workspaces', () => {
    const a = session();
    const b = session();

    expect(a.workspace).not.toBe(b.workspace);
    expect(a.wrap('/tools/x').args).not.toContain(b.workspace);
  });

  it('names the workspace after the owning node', () => {
    const s = new BubblewrapSandbox({ ...DEFAULT_SANDBOX_POLICY }).session('Research Agent');
    opened.push(s);

    expect(s.workspace).toContain('Research-Agent');
  });

  it('removes the workspace on dispose', () => {
    const s = new BubblewrapSandbox({ ...DEFAULT_SANDBOX_POLICY }).session('temp');
    expect(existsSync(s.workspace)).toBe(true);

    s.dispose();
    expect(existsSync(s.workspace)).toBe(false);
  });
});
