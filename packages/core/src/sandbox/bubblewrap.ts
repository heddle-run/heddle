/**
 * Linux backend, built on bubblewrap (`bwrap`).
 *
 * The sandbox starts empty and everything is added back explicitly: system
 * directories are bound read-only, /tmp is a fresh tmpfs per invocation, and
 * the working directory is read-only unless the caller opted it into
 * --allow-write. Notably absent is $HOME, which is where credentials
 * (~/.ssh, ~/.aws, ~/.config) actually live.
 *
 * Each tool invocation is its own bwrap container. What ties an agent's
 * invocations together is the session workspace — one host directory bound
 * read-write into each of them, and into no other session's.
 */
import { resolve } from 'node:path';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxSession } from './types.js';
import { baseEnv } from './types.js';
import { createWorkspace, removeDir } from './workspace.js';

/** Bound read-only when present. `-try` variants tolerate absent paths, which
 *  keeps one arg list working across merged-usr and split-usr distros. */
const SYSTEM_PATHS = ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/lib32', '/etc', '/opt'];

const SANDBOX_HOME = '/tmp/home';

class BubblewrapSession implements SandboxSession {
  readonly name = 'bubblewrap';
  readonly workspace: string;

  private policy: SandboxPolicy;
  private bwrapPath: string;

  constructor(policy: SandboxPolicy, bwrapPath: string, workspace: string) {
    this.policy = policy;
    this.bwrapPath = bwrapPath;
    this.workspace = workspace;
  }

  wrap(toolPath: string): SandboxCommand {
    const policy = this.policy;
    const cwd = resolve(policy.cwd ?? process.cwd());
    const tool = resolve(toolPath);

    const args: string[] = [
      '--die-with-parent',
      // Detaches the controlling terminal so a tool cannot push characters
      // back into heddle's tty with TIOCSTI.
      '--new-session',
      '--unshare-user-try',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup-try',
    ];

    if (!policy.network) args.push('--unshare-net');

    args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', SANDBOX_HOME);

    for (const path of SYSTEM_PATHS) {
      args.push(path === '/usr' ? '--ro-bind' : '--ro-bind-try', path, path);
    }

    // Read binds first, then writes: bwrap applies binds in order, so a
    // writable path nested inside a read-only one still ends up writable.
    for (const path of [cwd, tool, ...policy.readPaths]) {
      const abs = resolve(path);
      args.push('--ro-bind-try', abs, abs);
    }
    // Bound at its host path so paths a tool prints mean the same thing on
    // both sides of the boundary.
    args.push('--bind', this.workspace, this.workspace);
    for (const path of policy.writePaths) {
      const abs = resolve(path);
      args.push('--bind-try', abs, abs);
    }

    args.push('--chdir', cwd, '--clearenv');

    const env = baseEnv(policy, SANDBOX_HOME, '/tmp', this.workspace);
    for (const [key, value] of Object.entries(env)) {
      args.push('--setenv', key, value);
    }

    args.push('--', tool);

    return { command: this.bwrapPath, args, env, cwd };
  }

  dispose(): void {
    removeDir(this.workspace);
  }
}

export class BubblewrapSandbox implements Sandbox {
  readonly name = 'bubblewrap';

  private policy: SandboxPolicy;
  private bwrapPath: string;

  constructor(policy: SandboxPolicy, bwrapPath = 'bwrap') {
    this.policy = policy;
    this.bwrapPath = bwrapPath;
  }

  session(label: string): SandboxSession {
    return new BubblewrapSession(this.policy, this.bwrapPath, createWorkspace(label));
  }
}
