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
  readonly workspace: string;
  wrap(toolPath: string, args?: string[]): SandboxCommand;
  dispose(): void;
}

export interface Sandbox {
  readonly name: string;
  session(label: string): SandboxSession;
}

const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const ALWAYS_FORWARDED_ENV = ['LANG', 'LC_ALL', 'TZ', 'TERM'];

export function baseEnv(
  policy: SandboxPolicy,
  home: string,
  tmp: string,
  workspace: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: SANDBOX_PATH,
    HOME: home,
    TMPDIR: tmp,
    HEDDLE_WORKSPACE: workspace,
    HEDDLE_SANDBOX: '1',
  };

  for (const name of [...ALWAYS_FORWARDED_ENV, ...policy.passEnv]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  return env;
}
