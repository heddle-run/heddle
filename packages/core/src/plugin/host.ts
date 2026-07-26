/**
 * Owns a plugin's process and speaks the protocol to it.
 *
 * This is the piece that makes a plugin confinable. In-process, a plugin is
 * the same program as heddle: it shares the heap, the globals, `process.env`
 * and the filesystem, and nothing short of not loading it changes that. Out of
 * process it is a subprocess, which is the same thing a tool already is, and
 * gets the same treatment.
 *
 * Three properties follow from the process boundary, and they are the point:
 *
 * - **The environment is chosen, not inherited.** A plugin sees only what is
 *   passed to it. API keys in heddle's environment do not cross.
 * - **State does not outlive the run.** No shared globals to plant a hook on,
 *   no module registry that never unloads.
 * - **Failure is contained.** A plugin that crashes, hangs or exhausts memory
 *   takes down its own process, and its own run, not the server.
 *
 * The process starts on first use and lives until {@link dispose}. It is not
 * one process per call: `createExecutor` returns something stateful, and a
 * plugin is entitled to keep state between `execute` calls within a run.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { SandboxSession } from '../sandbox/types.js';
import { PluginError } from '../errors.js';
import {
  encode,
  isRequest,
  LineDecoder,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
} from './protocol.js';

const DEFAULT_CALL_TIMEOUT = 30_000;

/** How much of the plugin's stderr to keep for error messages. */
const STDERR_LIMIT = 4096;

export interface PluginHostOptions {
  /** argv to start the plugin. */
  command: string[];
  /** Working directory. Defaults to the parent's. */
  cwd?: string;
  /** Wall-clock budget for a single call. */
  timeout?: number;
  /**
   * Confines the plugin process, exactly as it would a tool. Optional: the
   * process boundary alone already denies the environment and the shared heap,
   * which are the leaks that matter. A sandbox adds the filesystem.
   */
  session?: SandboxSession;
  /**
   * Environment for the plugin. Defaults to nothing at all — a plugin gets no
   * variables unless a caller names them. This is the opposite of the
   * in-process default, where a plugin necessarily saw everything.
   */
  env?: Record<string, string>;
  /**
   * Serves the plugin's `runTool` calls.
   *
   * Usually supplied later with {@link PluginHost.setToolRunner}: a host is
   * built when the plugin loads, but the tool registry it would call into only
   * exists once a flow is compiled.
   */
  runTool?: ToolRunner;
}

export type ToolRunner = (
  name: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PluginHost {
  private proc?: ChildProcess;
  private pending = new Map<number, Pending>();
  private decoder = new LineDecoder();
  private nextId = 1;
  private stderr = '';
  private disposed = false;
  private toolRunner?: ToolRunner;
  /** Set once the process is gone, so later calls fail fast with the reason. */
  private dead?: Error;

  constructor(
    private readonly name: string,
    private readonly options: PluginHostOptions,
  ) {
    this.toolRunner = options.runTool;
  }

  /**
   * Give the plugin tool access, if it does not already have it.
   *
   * Called from `createExecutor`, which is where the compiled graph's
   * dependencies first exist. First writer wins: every executor in one compile
   * shares the same registry, so a later call would be setting the same thing,
   * and quietly replacing a live runner mid-run would be worse than ignoring it.
   */
  setToolRunner(run: ToolRunner): void {
    this.toolRunner ??= run;
  }

  /** Call a method on the plugin, starting it if it is not yet running. */
  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.disposed) {
      throw new PluginError(`plugin "${this.name}" was disposed`);
    }
    if (this.dead) throw this.dead;

    this.start();

    const id = this.nextId++;
    const timeout = this.options.timeout ?? DEFAULT_CALL_TIMEOUT;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // The process is not trustworthy after a timeout — it may still be
        // mid-reply, and a late response would be matched to nothing. Kill it
        // rather than leave the channel ambiguous.
        this.kill();
        reject(
          new PluginError(
            `plugin "${this.name}" did not answer ${method} within ${timeout}ms`,
          ),
        );
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  private start(): void {
    if (this.proc) return;

    const [command, ...args] = this.resolveCommand();

    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.options.cwd,
        // Empty by default. A plugin that needs a variable is given it
        // explicitly; nothing arrives just because heddle happened to have it.
        env: this.options.env ?? {},
      });
    } catch (err) {
      throw new PluginError(`failed to start plugin "${this.name}"`, { cause: err });
    }

    this.proc = proc;

    proc.stdout?.setEncoding('utf-8');
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of this.decoder.push(chunk)) this.receive(line);
    });

    proc.stderr?.setEncoding('utf-8');
    proc.stderr?.on('data', (chunk: string) => {
      // Bounded: a plugin in a logging loop should not be able to grow the
      // server's memory through its error channel.
      if (this.stderr.length < STDERR_LIMIT) {
        this.stderr = (this.stderr + chunk).slice(0, STDERR_LIMIT);
      }
    });

    proc.on('error', (err) => this.die(new PluginError(
      `plugin "${this.name}" failed to run: ${err.message}`,
      { cause: err },
    )));

    proc.on('close', (code, signal) => {
      const how = signal ? `signal ${signal}` : `exit code ${code}`;
      this.die(new PluginError(
        `plugin "${this.name}" exited (${how})${this.stderr ? `: ${this.stderr.trim()}` : ''}`,
      ));
    });

    // A plugin that exits while heddle is mid-write breaks the pipe; the real
    // failure is reported by the handlers above.
    proc.stdin?.on('error', () => {});
  }

  /** argv, confined by the sandbox when one was supplied. */
  private resolveCommand(): string[] {
    const { command, session } = this.options;
    if (!session) return command;

    const [executable, ...args] = command;
    const wrapped = session.wrap(executable, args);
    return [wrapped.command, ...wrapped.args];
  }

  private write(message: RpcMessage): void {
    if (!this.proc?.stdin?.writable) return;
    this.proc.stdin.write(encode(message));
  }

  private receive(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      // Malformed output is a bug in the plugin, and one worth naming: the
      // most common cause is writing logs to stdout instead of stderr.
      this.die(
        new PluginError(
          `plugin "${this.name}" wrote a line that is not JSON. ` +
            `Logs belong on stderr; stdout carries the protocol. Got: ${line.slice(0, 200)}`,
        ),
      );
      return;
    }

    if (isRequest(message)) {
      void this.serve(message);
      return;
    }
    this.settle(message);
  }

  /** Answer a request the plugin made of heddle. */
  private async serve(request: RpcRequest): Promise<void> {
    const respond = (response: Omit<RpcResponse, 'id'>): void =>
      this.write({ id: request.id, ...response });

    if (request.method !== 'runTool') {
      respond({ error: { name: 'PluginError', message: `unknown method "${request.method}"` } });
      return;
    }
    if (!this.toolRunner) {
      respond({ error: { name: 'PluginError', message: 'this plugin has no tool access' } });
      return;
    }

    const { name, input } = (request.params ?? {}) as {
      name?: unknown;
      input?: unknown;
    };
    if (typeof name !== 'string') {
      respond({ error: { name: 'PluginError', message: 'runTool requires a "name"' } });
      return;
    }

    try {
      const result = await this.toolRunner(
        name,
        (input ?? {}) as Record<string, unknown>,
      );
      respond({ result });
    } catch (err) {
      respond({
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /** Match a response to the call that is waiting for it. */
  private settle(response: RpcResponse): void {
    const id = typeof response.id === 'number' ? response.id : Number(response.id);
    const pending = this.pending.get(id);
    // A response to nothing is not fatal: it is what a late reply after a
    // timeout looks like, and the call it belonged to has already failed.
    if (!pending) return;

    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (response.error) {
      pending.reject(
        new PluginError(`plugin "${this.name}": ${response.error.message}`),
      );
      return;
    }
    pending.resolve(response.result);
  }

  /** Record the process as gone and fail everything still waiting on it. */
  private die(err: Error): void {
    if (this.dead) return;
    this.dead = err;

    const leftover = this.decoder.flush();
    if (leftover) {
      // Best effort: a final message may have arrived without its newline.
      try {
        this.settle(JSON.parse(leftover) as RpcResponse);
      } catch {
        // Not a message. The exit error below is the more useful report.
      }
    }

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private kill(): void {
    this.proc?.kill('SIGKILL');
  }

  /**
   * Stop the plugin and fail anything outstanding.
   *
   * Must be called at the end of every run, on success and on failure alike:
   * this is what stops one caller's code from outliving their request.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.die(new PluginError(`plugin "${this.name}" was disposed`));
    this.kill();
    this.proc = undefined;
  }
}
