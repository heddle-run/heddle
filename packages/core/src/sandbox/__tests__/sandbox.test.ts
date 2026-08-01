import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BubblewrapSandbox } from '../bubblewrap.js';
import { DEFAULT_SANDBOX_POLICY } from '../types.js';
import type { SandboxPolicy, SandboxSession } from '../types.js';
import { createScratchWorkspace, RESERVED_DIR } from '../../workspace/index.js';
import type { Workspace } from '../../workspace/index.js';

const opened: Workspace[] = [];

afterEach(() => {
  while (opened.length) opened.pop()!.dispose();
});

function workspace(label = 'test-agent'): Workspace {
  const created = createScratchWorkspace(label);
  opened.push(created);
  return created;
}

function session(
  overrides: Partial<SandboxPolicy> = {},
  ws: Workspace = workspace(),
): SandboxSession {
  const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, cwd: '/work', ...overrides };
  return new BubblewrapSandbox(policy).session('test-agent', ws);
}

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

  it('keeps the directory heddle was launched from readable, and read-only', () => {
    const cmd = session().wrap('/tools/echo');

    expect(pairIndex(cmd.args, '--ro-bind-try', '/work')).toBeGreaterThan(-1);
    expect(pairIndex(cmd.args, '--bind-try', '/work')).toBe(-1);
  });

  it('starts the tool in the workspace, not where heddle was launched', () => {
    const ws = workspace();
    const cmd = session({}, ws).wrap('/tools/echo');

    expect(cmd.cwd).toBe(ws.root);
    expect(pairIndex(cmd.args, '--chdir', ws.root)).toBeGreaterThan(-1);
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

/**
 * A session permits a workspace; it does not own one.
 *
 * Naming it, making it and removing it are the workspace factory's, and are
 * tested there. What is left here is the half a backend is answerable for:
 * turning `grants()` into binds, in an order where a nested grant wins.
 */
describe('bubblewrap sessions', () => {
  it('binds one writable workspace shared by every tool in the session', () => {
    const ws = workspace();
    const s = session({}, ws);
    const first = s.wrap('/tools/a');
    const second = s.wrap('/tools/b');

    expect(first.env.HEDDLE_WORKSPACE).toBe(ws.root);
    expect(second.env.HEDDLE_WORKSPACE).toBe(ws.root);
    expect(pairIndex(first.args, '--bind', ws.root)).toBeGreaterThan(-1);
    expect(pairIndex(second.args, '--bind', ws.root)).toBeGreaterThan(-1);
  });

  it('binds a session only the workspace it was given', () => {
    const a = workspace();
    const b = workspace();

    expect(a.root).not.toBe(b.root);
    expect(session({}, a).wrap('/tools/x').args).not.toContain(b.root);
  });

  it('makes the reserved directory read-only inside the writable root', () => {
    const ws = workspace();
    const cmd = session({}, ws).wrap('/tools/echo');

    const root = pairIndex(cmd.args, '--bind', ws.root);
    const reserved = pairIndex(cmd.args, '--ro-bind', join(ws.root, RESERVED_DIR));

    expect(root).toBeGreaterThan(-1);
    // After, or the nested grant loses and a tool can rewrite its peers.
    expect(reserved).toBeGreaterThan(root);
  });

  it('puts the workspace bin on PATH', () => {
    const ws = workspace();
    const cmd = session({}, ws).wrap('/tools/echo');

    expect(cmd.env.HEDDLE_WORKSPACE_BIN).toBe(ws.bin);
    expect(cmd.env.PATH.endsWith(`:${ws.bin}`)).toBe(true);
  });

  it('leaves the workspace alone when the session is disposed', () => {
    const ws = workspace();
    session({}, ws).dispose();

    expect(existsSync(ws.root)).toBe(true);
  });
});
