import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecResult, Executor, ExecutorScope } from './types.js';
import type { Sandbox, SandboxCommand, SandboxSession } from '../sandbox/index.js';
import { ToolError } from '../errors.js';

const DEFAULT_TIMEOUT = 30_000;
const UNSCOPED_SESSION_LABEL = 'tool';

export interface SubprocessExecutorOptions {
  timeout?: number;
  sandbox?: Sandbox;
  session?: SandboxSession;
}

export class SubprocessExecutor implements Executor {
  private readonly timeout: number;
  private readonly sandbox?: Sandbox;
  private readonly session?: SandboxSession;

  constructor(options?: SubprocessExecutorOptions) {
    this.timeout = options?.timeout ?? DEFAULT_TIMEOUT;
    this.sandbox = options?.sandbox;
    this.session = options?.session;
  }

  beginScope(label: string): ExecutorScope {
    if (!this.sandbox) {
      return { executor: this, dispose: () => {} };
    }

    const session = this.sandbox.session(label);
    return {
      executor: new SubprocessExecutor({
        timeout: this.timeout,
        sandbox: this.sandbox,
        session,
      }),
      workspace: session.workspace,
      dispose: once(() => session.dispose()),
    };
  }

  async execute(
    signal: AbortSignal | undefined,
    toolPath: string,
    input: Record<string, unknown>,
  ): Promise<ExecResult> {
    const session = this.session ?? this.sandbox?.session(UNSCOPED_SESSION_LABEL);
    const ownsSession = session !== undefined && session !== this.session;
    const wrapped = session?.wrap(toolPath);

    const release = once(() => {
      wrapped?.cleanup?.();
      if (ownsSession) session?.dispose();
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

      const proc = spawnTool(toolPath, wrapped, controller.signal);
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
  signal: AbortSignal,
): ChildProcessWithoutNullStreams {
  return spawn(wrapped?.command ?? toolPath, wrapped?.args ?? [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    signal,
    ...(wrapped ? { env: wrapped.env, cwd: wrapped.cwd } : {}),
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
