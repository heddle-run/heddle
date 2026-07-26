/**
 * macOS backend, built on Seatbelt (`sandbox-exec`).
 *
 * Seatbelt confines a process in place rather than rebuilding a filesystem
 * view, so the policy is expressed as a deny-by-default SBPL profile that
 * allows back the system paths, the working directory (read-only), and the
 * session workspace. The effect matches the bubblewrap backend: no $HOME, no
 * writes outside the workspace, the per-invocation scratch, and any
 * --allow-write paths.
 *
 * `sandbox-exec` is formally deprecated by Apple but remains the only
 * general-purpose confinement primitive shipped with macOS, and is still what
 * the platform's own tooling relies on.
 */
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { Sandbox, SandboxCommand, SandboxPolicy, SandboxSession } from './types.js';
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

/**
 * The shared temp directories, which have to stay writable.
 *
 * This is the one place the two backends genuinely differ: bubblewrap mounts a
 * private tmpfs over /tmp, so a Linux-confined tool never sees the host's temp
 * at all. Seatbelt confines in place and cannot remount, and too much breaks
 * without these — /bin/sh spills here-documents to a hardcoded /tmp path and
 * ignores TMPDIR entirely, so denying them breaks ordinary shell tools. TMPDIR
 * still points at the per-invocation scratch, so well-behaved tools remain
 * isolated; these are the escape hatch for ones that are not.
 */
const SHARED_TEMP_PATHS = ['/private/tmp', '/private/var/tmp'];

/** Devices a tool may open for writing even though the rest of /dev is read-only. */
const WRITABLE_DEVICES = [
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/dtracehelper',
];

/** SBPL string literals are double-quoted with backslash escapes. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Seatbelt matches on fully resolved paths, so /tmp/x would never match a
 * rule written against its real location under /private/tmp. Resolving the
 * deepest existing ancestor keeps not-yet-created paths usable as rules.
 */
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

function subpathRule(paths: string[]): string {
  return paths.map((p) => `(subpath ${sbplString(realPath(p))})`).join(' ');
}

class SeatbeltSession implements SandboxSession {
  readonly name = 'seatbelt';
  readonly workspace: string;

  private policy: SandboxPolicy;

  constructor(policy: SandboxPolicy, workspace: string) {
    this.policy = policy;
    this.workspace = realPath(workspace);
  }

  wrap(toolPath: string): SandboxCommand {
    const policy = this.policy;
    const cwd = realPath(policy.cwd ?? process.cwd());
    const tool = realPath(toolPath);

    // Fresh per invocation, so scratch state does not leak between an agent's
    // tool calls. Anything meant to survive belongs in the workspace.
    const scratch = realPath(mkdtempSync(join(tmpdir(), 'heddle-scratch-')));
    const home = join(scratch, 'home');
    mkdirSync(home);

    const readPaths = [...SYSTEM_READ_PATHS, cwd, tool, ...policy.readPaths];
    const writePaths = [
      scratch,
      this.workspace,
      ...SHARED_TEMP_PATHS,
      ...policy.writePaths,
    ];

    const profile = [
      '(version 1)',
      '(deny default)',
      '(allow process-exec*)',
      '(allow process-fork)',
      '(allow sysctl-read)',
      '(allow mach-lookup)',
      '(allow signal (target self))',
      '(allow file-read-metadata)',
      // dyld stats the root directory during startup; without this every
      // dynamically linked binary aborts before main().
      `(allow file-read* (literal "/") ${subpathRule(readPaths)})`,
      `(allow file-write-data ${WRITABLE_DEVICES.map((d) => `(literal ${sbplString(d)})`).join(' ')})`,
      `(allow file-read* file-write* ${subpathRule(writePaths)})`,
      policy.network ? '(allow network*)' : '(deny network*)',
    ].join('\n');

    const env = baseEnv(policy, home, scratch, this.workspace);

    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, tool],
      env,
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

  private policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  session(label: string): SandboxSession {
    return new SeatbeltSession(this.policy, createWorkspace(label));
  }
}
