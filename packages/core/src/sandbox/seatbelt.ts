import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  Sandbox,
  SandboxCommand,
  SandboxPolicy,
  SandboxSession,
} from './types.js';
import { baseEnv } from './types.js';
import { createWorkspace, removeDir } from '../workspace/index.js';
import type { Workspace, WorkspaceGrant } from '../workspace/index.js';

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
  readonly workspace: Workspace;

  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy, workspace: Workspace) {
    this.policy = policy;
    this.workspace = workspace;
  }

  wrap(toolPath: string, extraArgs: string[] = []): SandboxCommand {
    // Readable, and no longer where the tool starts — see the same comment in
    // the bubblewrap backend for why.
    const launchedFrom = realPath(this.policy.cwd ?? process.cwd());
    const cwd = realPath(this.workspace.root);
    const tool = realPath(toolPath);

    const scratch = realPath(createWorkspace('scratch', 'heddle'));
    const home = join(scratch, 'home');
    mkdirSync(home);

    const grants = this.workspace.grants();
    const profile = buildProfile({
      readPaths: [
        ...SYSTEM_READ_PATHS,
        launchedFrom,
        tool,
        ...this.policy.readPaths,
        // Where the workspace's bin links point -- see the same list in the
        // bubblewrap backend.
        ...this.workspace.toolPaths(),
        ...pathsWith(grants, 'read'),
      ],
      writePaths: [
        scratch,
        ...SHARED_TEMP_PATHS,
        ...this.policy.writePaths,
        ...pathsWith(grants, 'write'),
      ],
      // Written back as a deny after the allows, because a read grant sits
      // inside a writable one — `.heddle` inside the workspace root — and a
      // profile resolves that by taking the last rule that matches. Only the
      // grants, never `toolPaths`: those are outside the workspace, so denying
      // writes there would quietly overrule an `--allow-write` the operator
      // asked for.
      readOnlyPaths: pathsWith(grants, 'read'),
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
    return;
  }
}

export class SeatbeltSandbox implements Sandbox {
  readonly name = 'seatbelt';

  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  session(label: string, workspace: Workspace): SandboxSession {
    return new SeatbeltSession(this.policy, workspace);
  }
}

function pathsWith(
  grants: WorkspaceGrant[],
  access: WorkspaceGrant['access'],
): string[] {
  return grants.filter((grant) => grant.access === access).map((g) => g.path);
}

function buildProfile(rules: {
  readPaths: string[];
  writePaths: string[];
  readOnlyPaths: string[];
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
    ...(rules.readOnlyPaths.length > 0
      ? [`(deny file-write* ${subpathRule(rules.readOnlyPaths)})`]
      : []),
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
