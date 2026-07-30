import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  Sandbox,
  SandboxCommand,
  SandboxPolicy,
  SandboxSession,
} from './types.js';
import { baseEnv } from './types.js';
import { createWorkspace, removeDir } from './workspace.js';

const SYSTEM_READ_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/dev',
  '/opt',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
];

const SHARED_TEMP_PATHS = ['/private/tmp', '/private/var/tmp'];

const WRITABLE_DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/dtracehelper',
];

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

class SeatbeltSession implements SandboxSession {
  readonly name = 'seatbelt';
  readonly workspace: string;

  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy, workspace: string) {
    this.policy = policy;
    this.workspace = realPath(workspace);
  }

  wrap(toolPath: string, extraArgs: string[] = []): SandboxCommand {
    const cwd = realPath(this.policy.cwd ?? process.cwd());
    const tool = realPath(toolPath);

    const scratch = realPath(mkdtempSync(join(tmpdir(), 'heddle-scratch-')));
    const home = join(scratch, 'home');
    mkdirSync(home);

    const profile = buildProfile({
      readPaths: [...SYSTEM_READ_PATHS, cwd, tool, ...this.policy.readPaths],
      writePaths: [
        scratch,
        this.workspace,
        ...SHARED_TEMP_PATHS,
        ...this.policy.writePaths,
      ],
      network: this.policy.network,
    });

    return {
      command: SANDBOX_EXEC,
      args: ['-p', profile, tool, ...extraArgs],
      env: baseEnv(this.policy, home, scratch, this.workspace),
      cwd,
      cleanup: () => removeDir(scratch),
    };
  }

  dispose(): void {
    removeDir(this.workspace);
  }
}

export class SeatbeltSandbox implements Sandbox {
  readonly name = 'seatbelt';

  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  session(label: string): SandboxSession {
    return new SeatbeltSession(this.policy, createWorkspace(label));
  }
}

function buildProfile(rules: {
  readPaths: string[];
  writePaths: string[];
  network: boolean;
}): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow signal (target self))',
    '(allow file-read-metadata)',
    `(allow file-read* (literal "/") ${subpathRule(rules.readPaths)})`,
    `(allow file-write-data ${literalRule(WRITABLE_DEVICES)})`,
    `(allow file-read* file-write* ${subpathRule(rules.writePaths)})`,
    rules.network ? '(allow network*)' : '(deny network*)',
  ].join('\n');
}

function subpathRule(paths: string[]): string {
  return paths.map((path) => `(subpath ${sbplString(realPath(path))})`).join(' ');
}

function literalRule(paths: string[]): string {
  return paths.map((path) => `(literal ${sbplString(path)})`).join(' ');
}

function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function realPath(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      return realpathSync(current);
    } catch {
      const parent = resolve(current, '..');
      if (parent === current) return resolve(path);
      current = parent;
    }
  }
}
