import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import type { ExecResult, Executor, ExecutorScope } from './types.js';
import type { Sandbox, SandboxCommand, SandboxSession } from '../sandbox/index.js';
import type {
  Workspace,
  WorkspaceFactory,
  WorkspaceTool,
} from '../workspace/index.js';
import { createWorkspaceFactory, workspaceEnv } from '../workspace/index.js';
import { ToolError } from '../errors.js';

const DEFAULT_TIMEOUT = 30_000;
const UNSCOPED_SESSION_LABEL = 'tool';

export interface SubprocessExecutorOptions {
  timeout?: number;
  sandbox?: Sandbox;
  session?: SandboxSession;
  /**
   * What opens a workspace per scope.
   *
   * Defaulted, so `new SubprocessExecutor()` still gives every scope somewhere
   * to work. Confinement is what `sandbox` decides; where the work happens is
   * decided here, and the two are now independent — which is the point.
   */
  workspaces?: WorkspaceFactory;
  /** This scope's workspace. Set on the executor a `beginScope` returns. */
  workspace?: Workspace;
  /**
   * What goes in each workspace's `bin`, reachable by name from inside it.
   *
   * Supplied by whoever built the tool registry, since that is who knows — on a
   * server the registry is per run, so this cannot be settled at startup.
   */
  tools?: WorkspaceTool[];
}

export class SubprocessExecutor implements Executor {
  private readonly timeout: number;
  private readonly sandbox?: Sandbox;
  private readonly session?: SandboxSession;
  private readonly workspaces: WorkspaceFactory;
  private readonly workspace?: Workspace;
  private readonly tools: WorkspaceTool[];

  constructor(options?: SubprocessExecutorOptions) {
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.sandbox = options?.sandbox;
    this.session = options?.session;
    this.workspaces = options?.workspaces ?? createWorkspaceFactory();
    this.workspace = options?.workspace;
    this.tools = options?.tools ?? [];
  }

  beginScope(label: string): ExecutorScope {
    const workspace = this.workspaces.create(label, this.tools);
    const session = this.sandbox?.session(label, workspace);

    return {
      executor: new SubprocessExecutor({
        timeout: this.timeout,
        sandbox: this.sandbox,
        workspaces: this.workspaces,
        tools: this.tools,
        session,
        workspace,
      }),
      workspace: workspace.root,
      // Session first. A backend may hold a handle on the directory, and it
      // should let go before the workspace copies anything back out of it and
      // removes it.
      dispose: once(() => {
        session?.dispose();
        workspace.dispose();
      }),
    };
  }

  async execute(
    signal: AbortSignal | undefined,
    toolPath: string,
    input: Record<string, unknown>,
  ): Promise<ExecResult> {
    // A bare `ToolNode` opens no scope, so it gets a throwaway workspace of its
    // own for the length of one call — as it always got a throwaway session.
    const workspace =
      this.workspace ??
      this.workspaces.create(UNSCOPED_SESSION_LABEL, this.tools);
    const ownsWorkspace = workspace !== this.workspace;

    const session =
      this.session ?? this.sandbox?.session(UNSCOPED_SESSION_LABEL, workspace);
    const ownsSession = session !== undefined && session !== this.session;
    const wrapped = session?.wrap(toolPath);

    const release = once(() => {
      wrapped?.cleanup?.();
      if (ownsSession) session?.dispose();
      if (ownsWorkspace) workspace.dispose();
    });

    return new Promise<ExecResult>((resolve, reject) => {
      const controller = new AbortController();

      const timer = setTimeout(() => {
        controller.abort();
        reject(new ToolError(`execution timed out after ${this.timeout}ms`));
      }, this.timeout);

      if (signal?.aborted) {
        clearTimeout(timer);
        release();
        reject(new ToolError('execution aborted'));
        return;
      }

      const onExternalAbort = (): void => {
        controller.abort();
        clearTimeout(timer);
        reject(new ToolError('execution aborted'));
      };
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        release();
      };

      const proc = spawnTool(toolPath, wrapped, workspace, controller.signal);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      proc.on('error', (err) => {
        settle();
        if (controller.signal.aborted) return;
        reject(
          new ToolError(`execution failed: ${joined(stderr)}`, { cause: err }),
        );
      });

      proc.on('close', (code) => {
        settle();
        const stderrText = joined(stderr);

        if (code !== 0) {
          reject(
            new ToolError(
              `execution failed with exit code ${code}: ${stderrText}`,
            ),
          );
          return;
        }

        try {
          resolve({ output: parseOutput(joined(stdout)), stderr: stderrText });
        } catch (err) {
          reject(err);
        }
      });

      proc.stdin.on('error', ignoreBrokenPipe);
      proc.stdin.write(JSON.stringify(input));
      proc.stdin.end();
    });
  }
}

function spawnTool(
  toolPath: string,
  wrapped: SandboxCommand | undefined,
  workspace: Workspace,
  signal: AbortSignal,
): ChildProcessWithoutNullStreams {
  if (wrapped) {
    return spawn(wrapped.command, wrapped.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal,
      env: wrapped.env,
      cwd: wrapped.cwd,
    });
  }

  // Resolved, because the cwd below is the workspace and a relative tool path
  // would then be looked for inside it. `FileRegistry` builds its paths by
  // joining whatever `--tools-dir` was given, so a relative flag means relative
  // paths — which used to work only because an unconfined tool inherited
  // heddle's own working directory. Both sandbox backends already resolve, and
  // that asymmetry was the bug: `--safe` found the tool and running without it
  // did not.
  return spawn(resolve(toolPath), [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    signal,
    // The parent's environment, plus the workspace. Deliberately not the
    // sandbox's cleared environment: an unconfined tool inherits what heddle
    // has, as it always did, and this adds to that rather than replacing it.
    env: { ...process.env, ...workspaceEnv(workspace, process.env.PATH) },
    cwd: workspace.root,
  });
}

function parseOutput(stdout: string): Record<string, unknown> {
  if (stdout.length === 0) return {};

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new ToolError(`failed to parse output JSON: ${stdout}`, {
      cause: err,
    });
  }
}

function joined(chunks: Buffer[]): string {
  return Buffer.concat(chunks).toString();
}

function ignoreBrokenPipe(): void {
  return;
}

function once(action: () => void): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    action();
  };
}
