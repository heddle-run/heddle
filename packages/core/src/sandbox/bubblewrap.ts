import { resolve } from 'node:path';
import type {
  Sandbox,
  SandboxCommand,
  SandboxPolicy,
  SandboxSession,
} from './types.js';
import { baseEnv } from './types.js';
import { createWorkspace, removeDir } from './workspace.js';

const SYSTEM_PATHS = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/lib32',
  '/etc',
  '/opt',
];

const REQUIRED_SYSTEM_PATH = '/usr';
const SANDBOX_HOME = '/tmp/home';
const SANDBOX_TMP = '/tmp';

const ISOLATION_ARGS = [
  '--die-with-parent',
  '--new-session',
  '--unshare-user-try',
  '--unshare-pid',
  '--unshare-ipc',
  '--unshare-uts',
  '--unshare-cgroup-try',
];

class BubblewrapSession implements SandboxSession {
  readonly name = 'bubblewrap';
  readonly workspace: string;

  private readonly policy: SandboxPolicy;
  private readonly bwrapPath: string;

  constructor(policy: SandboxPolicy, bwrapPath: string, workspace: string) {
    this.policy = policy;
    this.bwrapPath = bwrapPath;
    this.workspace = workspace;
  }

  wrap(toolPath: string, extraArgs: string[] = []): SandboxCommand {
    const cwd = resolve(this.policy.cwd ?? process.cwd());
    const tool = resolve(toolPath);
    const env = baseEnv(this.policy, SANDBOX_HOME, SANDBOX_TMP, this.workspace);

    const args = [
      ...ISOLATION_ARGS,
      ...networkArgs(this.policy),
      ...filesystemArgs(),
      ...systemBindArgs(),
      ...readBindArgs([cwd, tool, ...this.policy.readPaths]),
      ...writeBindArgs(this.workspace, this.policy.writePaths),
      '--chdir',
      cwd,
      '--clearenv',
      ...envArgs(env),
      '--',
      tool,
      ...extraArgs,
    ];

    return { command: this.bwrapPath, args, env, cwd };
  }

  dispose(): void {
    removeDir(this.workspace);
  }
}

export class BubblewrapSandbox implements Sandbox {
  readonly name = 'bubblewrap';

  private readonly policy: SandboxPolicy;
  private readonly bwrapPath: string;

  constructor(policy: SandboxPolicy, bwrapPath = 'bwrap') {
    this.policy = policy;
    this.bwrapPath = bwrapPath;
  }

  session(label: string): SandboxSession {
    return new BubblewrapSession(
      this.policy,
      this.bwrapPath,
      createWorkspace(label),
    );
  }
}

function networkArgs(policy: SandboxPolicy): string[] {
  return policy.network ? [] : ['--unshare-net'];
}

function filesystemArgs(): string[] {
  return [
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--tmpfs',
    SANDBOX_TMP,
    '--dir',
    SANDBOX_HOME,
  ];
}

function systemBindArgs(): string[] {
  return SYSTEM_PATHS.flatMap((path) => [
    path === REQUIRED_SYSTEM_PATH ? '--ro-bind' : '--ro-bind-try',
    path,
    path,
  ]);
}

function readBindArgs(paths: string[]): string[] {
  return paths.flatMap((path) => {
    const absolute = resolve(path);
    return ['--ro-bind-try', absolute, absolute];
  });
}

function writeBindArgs(workspace: string, writePaths: string[]): string[] {
  return [
    '--bind',
    workspace,
    workspace,
    ...writePaths.flatMap((path) => {
      const absolute = resolve(path);
      return ['--bind-try', absolute, absolute];
    }),
  ];
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => [
    '--setenv',
    key,
    value,
  ]);
}
