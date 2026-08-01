import { resolve } from 'node:path';
import type {
  Sandbox,
  SandboxCommand,
  SandboxPolicy,
  SandboxSession,
} from './types.js';
import { baseEnv } from './types.js';
import type { Workspace, WorkspaceGrant } from '../workspace/index.js';

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
  readonly workspace: Workspace;

  private readonly policy: SandboxPolicy;
  private readonly bwrapPath: string;

  constructor(policy: SandboxPolicy, bwrapPath: string, workspace: Workspace) {
    this.policy = policy;
    this.bwrapPath = bwrapPath;
    this.workspace = workspace;
  }

  wrap(toolPath: string, extraArgs: string[] = []): SandboxCommand {
    // Still bound read-only, and no longer where the tool starts. heddle's own
    // working directory is where the flow file and whatever sits beside it
    // live, so a tool naming an absolute path into it keeps working; a tool
    // reading `./something` now reads it out of the workspace, which is the
    // point.
    const launchedFrom = resolve(this.policy.cwd ?? process.cwd());
    const cwd = this.workspace.root;
    const tool = resolve(toolPath);
    const env = baseEnv(this.policy, SANDBOX_HOME, SANDBOX_TMP, this.workspace);

    const args = [
      ...ISOLATION_ARGS,
      ...networkArgs(this.policy),
      ...filesystemArgs(),
      ...systemBindArgs(),
      ...readBindArgs([
        launchedFrom,
        tool,
        ...this.policy.readPaths,
        // Where the workspace's bin links point. A symlink is only reachable if
        // its target is, and heddle's own read paths come from flags -- so a
        // per-request tool would otherwise be linked and unopenable.
        ...this.workspace.toolPaths(),
      ]),
      ...writeBindArgs(this.policy.writePaths),
      ...grantArgs(this.workspace.grants()),
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
    return;
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

  session(label: string, workspace: Workspace): SandboxSession {
    return new BubblewrapSession(this.policy, this.bwrapPath, workspace);
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

function writeBindArgs(writePaths: string[]): string[] {
  return writePaths.flatMap((path) => {
    const absolute = resolve(path);
    return ['--bind-try', absolute, absolute];
  });
}

/**
 * The workspace's own binds, last and in order.
 *
 * bwrap applies binds in the order it is given them, so a grant nested inside
 * an earlier one resolves to the later — which is how the read-only `.heddle`
 * inside the writable root works, and why this list must not be sorted or
 * deduplicated.
 */
function grantArgs(grants: WorkspaceGrant[]): string[] {
  return grants.flatMap((grant) => {
    const absolute = resolve(grant.path);
    return [grant.access === 'write' ? '--bind' : '--ro-bind', absolute, absolute];
  });
}

function envArgs(env: Record<string, string>): string[] {
  return Object.entries(env).flatMap(([key, value]) => [
    '--setenv',
    key,
    value,
  ]);
}
