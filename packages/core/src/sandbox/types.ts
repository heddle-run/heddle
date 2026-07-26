/**
 * Sandbox backends confine tool subprocesses.
 *
 * A backend never changes what a tool *is* — it only rewrites how the tool is
 * invoked, turning `/path/to/tool` into `bwrap ... -- /path/to/tool`. That
 * keeps the confinement entirely inside the executor, so nothing in the graph,
 * node, or spec layers has to know a sandbox exists.
 */

/** SandboxPolicy describes what a confined tool is permitted to reach. */
export interface SandboxPolicy {
  /**
   * Directories the tool may read, on top of the system directories every
   * backend grants. The working directory is normally included here.
   */
  readPaths: string[];
  /** Directories the tool may write to. Read access is implied. */
  writePaths: string[];
  /** Whether the tool may use the network. */
  network: boolean;
  /**
   * Environment variable names forwarded from the parent process. Everything
   * else is dropped, so API keys in heddle's own environment never reach a
   * tool unless they are named here.
   */
  passEnv: string[];
  /** Working directory for the tool. Defaults to the parent's cwd. */
  cwd?: string;
}

export const DEFAULT_SANDBOX_POLICY: Readonly<SandboxPolicy> = {
  readPaths: [],
  writePaths: [],
  network: true,
  passEnv: [],
};

/** SandboxCommand is a tool invocation rewritten to run under confinement. */
export interface SandboxCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  /** Releases any scratch state the backend allocated for this invocation. */
  cleanup?: () => void;
}

/**
 * A sandbox session scopes a group of tool invocations to one shared workspace.
 *
 * bwrap has no equivalent of `docker exec`, so a session is not a container
 * that stays alive: every tool still gets its own fresh container, with its own
 * namespaces and its own /tmp. What the session provides is continuity — one
 * writable workspace directory bound into all of them, so an agent's tools can
 * hand files to each other while remaining invisible to any other agent's
 * session.
 */
export interface SandboxSession {
  /** Backend identifier, e.g. "bubblewrap". Used in errors and --verbose logs. */
  readonly name: string;
  /** Host path of the shared workspace, exported to tools as $HEDDLE_WORKSPACE. */
  readonly workspace: string;
  wrap(toolPath: string): SandboxCommand;
  /** Destroys the workspace. Wrapping after disposal is a programming error. */
  dispose(): void;
}

/** Sandbox opens sessions under a fixed policy. */
export interface Sandbox {
  readonly name: string;
  /**
   * Opens a session with a fresh workspace. `label` identifies the owner (an
   * agent node name) and appears in the workspace path to make a confined
   * process traceable back to the node that spawned it.
   */
  session(label: string): SandboxSession;
}

/** Environment variables always set inside a sandbox, whatever the backend. */
export function baseEnv(
  policy: SandboxPolicy,
  home: string,
  tmp: string,
  workspace: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    // Per invocation, so temp files do not accumulate across an agent's run.
    TMPDIR: tmp,
    // Shared across the session: this is where tools pass work to each other.
    HEDDLE_WORKSPACE: workspace,
    // Marks the confined side of the boundary so a tool can adapt (skip a
    // cache write, pick a different temp root) instead of just failing.
    HEDDLE_SANDBOX: '1',
  };

  for (const name of ['LANG', 'LC_ALL', 'TZ', 'TERM', ...policy.passEnv]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }

  return env;
}
