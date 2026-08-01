import type { Workspace } from '../workspace/index.js';
import { workspaceEnv } from '../workspace/index.js';

export interface SandboxPolicy {
  readPaths: string[];
  writePaths: string[];
  network: boolean;
  passEnv: string[];
  cwd?: string;
}

export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = {
  readPaths: [],
  writePaths: [],
  network: true,
  passEnv: [],
};

export interface SandboxCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  cleanup?: () => void;
}

export interface SandboxSession {
  readonly name: string;
  readonly workspace: Workspace;
  wrap(toolPath: string, args?: string[]): SandboxCommand;
  dispose(): void;
}

export interface Sandbox {
  readonly name: string;
  /**
   * Confine one node scope's tool calls, in the workspace that scope was given.
   *
   * The workspace arrives rather than being made here. A session's job is to
   * permit what `workspace.grants()` names; deciding what is in a workspace, or
   * whether there is one at all, is not confinement and does not belong to a
   * backend. Disposing a session therefore does not remove the directory — the
   * executor that opened it does that, after the session has let go.
   */
  session(label: string, workspace: Workspace): SandboxSession;
}

const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const ALWAYS_FORWARDED_ENV = ['LANG', 'LC_ALL', 'TZ', 'TERM'];

export function baseEnv(
  policy: SandboxPolicy,
  home: string,
  tmp: string,
  workspace: Workspace,
): Record<string, string> {
  const env: Record<string, string> = {
    HOME: home,
    TMPDIR: tmp,
    HEDDLE_SANDBOX: '1',
    ...workspaceEnv(workspace, SANDBOX_PATH),
  };

  for (const name of [...ALWAYS_FORWARDED_ENV, ...policy.passEnv]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  return env;
}
