import { spawn } from 'node:child_process';
import type { ExecResult, Executor, ExecutorScope } from './types.js';
import type { Sandbox, SandboxSession } from '../sandbox/index.js';
import { ToolError } from '../errors.js';

const DEFAULT_TIMEOUT = 30_000;

export interface SubprocessExecutorOptions {
  timeout?: number;
  /** When set, every tool is launched through this sandbox instead of directly. */
  sandbox?: Sandbox;
  /**
   * Session shared by this executor's tool calls. Set by beginScope; callers
   * configuring an executor pass `sandbox` and let scopes manage sessions.
   */
  session?: SandboxSession;
}

/** SubprocessExecutor runs tools as external processes. */
export class SubprocessExecutor implements Executor {
  private timeout: number;
  private sandbox?: Sandbox;
  private session?: SandboxSession;

  constructor(options?: SubprocessExecutorOptions) {
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.sandbox = options?.sandbox;
    this.session = options?.session;
  }

  beginScope(label: string): ExecutorScope {
    if (!this.sandbox) {
      // Nothing to isolate: hand back this executor and make disposal a no-op.
      return { executor: this, dispose: () => {} };
    }

    const session = this.sandbox.session(label);
    let disposed = false;

    return {
      executor: new SubprocessExecutor({
        timeout: this.timeout,
        sandbox: this.sandbox,
        session,
      }),
      dispose: () => {
        if (disposed) return;
        disposed = true;
        session.dispose();
      },
    };
  }

  async execute(
    signal: AbortSignal | undefined,
    toolPath: string,
    input: Record<string, unknown>,
  ): Promise<ExecResult> {
    const inputJSON = JSON.stringify(input);

    // A call outside any scope still gets confined; it just gets a throwaway
    // session of its own, which is disposed as soon as the tool exits.
    const session = this.session ?? this.sandbox?.session('tool');
    const ownsSession = session !== undefined && session !== this.session;
    const wrapped = session?.wrap(toolPath);

    return new Promise<ExecResult>((resolve, reject) => {
      const ac = new AbortController();

      // Idempotent: per-invocation sandbox state is released once, on
      // whichever of the terminal paths below runs first.
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        wrapped?.cleanup?.();
        if (ownsSession) session?.dispose();
      };

      const timer = setTimeout(() => {
        ac.abort();
        reject(
          new ToolError(
            `execution timed out after ${this.timeout}ms`,
          ),
        );
      }, this.timeout);

      // If external signal is already aborted, reject immediately
      if (signal?.aborted) {
        clearTimeout(timer);
        release();
        reject(new ToolError('execution aborted'));
        return;
      }

      const onExternalAbort = () => {
        ac.abort();
        clearTimeout(timer);
        reject(new ToolError('execution aborted'));
      };
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      const proc = spawn(wrapped?.command ?? toolPath, wrapped?.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: ac.signal,
        // Outside a sandbox the tool inherits heddle's environment, as before.
        // Inside one it gets only what the policy allows through, so secrets
        // in heddle's own environment are not handed to tool code.
        ...(wrapped ? { env: wrapped.env, cwd: wrapped.cwd } : {}),
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      proc.on('error', (err) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        release();
        if (ac.signal.aborted) return; // already handled by timeout
        const stderrStr = Buffer.concat(stderrChunks).toString();
        reject(
          new ToolError(`execution failed: ${stderrStr}`, { cause: err }),
        );
      });

      proc.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
        release();

        const stderrStr = Buffer.concat(stderrChunks).toString();

        if (code !== 0) {
          reject(
            new ToolError(
              `execution failed with exit code ${code}: ${stderrStr}`,
            ),
          );
          return;
        }

        const stdoutStr = Buffer.concat(stdoutChunks).toString();
        let output: Record<string, unknown>;

        if (stdoutStr.length > 0) {
          try {
            output = JSON.parse(stdoutStr);
          } catch (err) {
            reject(
              new ToolError(
                `failed to parse output JSON: ${stdoutStr}`,
                { cause: err },
              ),
            );
            return;
          }
        } else {
          output = {};
        }

        resolve({ output, stderr: stderrStr });
      });

      // A tool that exits before reading stdin breaks the pipe; the real
      // failure is reported by the 'error'/'close' handlers above.
      proc.stdin.on('error', () => {});

      // Write input to stdin
      proc.stdin.write(inputJSON);
      proc.stdin.end();
    });
  }
}
