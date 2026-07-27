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
  isPluginMethod,
  isRequest,
  LineDecoder,
  PLUGIN_METHODS,
  type HostMethod,
  type HostMethods,
  type PluginCapability,
  type RpcMessage,
  type RpcRequest,
  type RpcResponse,
  type RunToolParams,
} from './protocol.js';

const DEFAULT_CALL_TIMEOUT = 30_000;

/** How much of the plugin's stderr to keep for error messages. */
const STDERR_LIMIT = 4096;

export interface PluginHostOptions {
  /** argv to start the plugin. */
  command: string[];
  /** Working directory. Defaults to the parent's. */
  cwd?: string;
  /**
   * Wall-clock budget for a single call, defaulting to
   * {@link DEFAULT_CALL_TIMEOUT}. Every method shares it, so a caller that
   * raises it to suit the slowest verb raises it for all of them.
   */
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
   * The reverse calls this plugin may make. Empty by default, on the same
   * reasoning as `env`: what a plugin gets is chosen for it, never inherited
   * from what heddle happens to be able to do.
   *
   * This is the *settled* set — the manifest's request after the loader has
   * checked it against the operator's grant — so anything listed here has
   * already been allowed twice, and anything absent is refused without a round
   * trip to whoever configured the run.
   */
  capabilities?: PluginCapability[];
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

/** Names a declared reverse call that has no implementation. See {@link PluginHost.serve}. */
function unserved(method: never): string {
  return `heddle declares "${String(method)}" but does not serve it`;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Cancels the call's timer and its abort listener, however it ends. */
  release: () => void;
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
  /** The sandbox's scratch release, held from `wrap` until the process ends. */
  private cleanupSandbox?: () => void;
  private readonly granted: ReadonlySet<PluginCapability>;

  constructor(
    private readonly name: string,
    private readonly options: PluginHostOptions,
  ) {
    this.toolRunner = options.runTool;
    // Copied at construction, not read from options per call: the grant is
    // settled when the plugin loads, and a set that could be widened afterwards
    // would be a policy the plugin's own process could outlive.
    this.granted = new Set(options.capabilities ?? []);
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

  /**
   * Call a method on the plugin, starting it if it is not yet running.
   *
   * Generic over the method so the params are checked against the verb rather
   * than accepted as any object: the wire is JSON either way, and a params
   * shape that does not match the method is a failure the plugin reports from
   * another process, long after the call site that got it wrong.
   *
   * `signal` is the run's own. Without it a pending call is uninterruptible:
   * the runner checks its signal between nodes, so an aborted run — a client
   * that hung up, a wall-clock budget spent — would still wait out this call's
   * whole timeout before its concurrency slot came back.
   */
  async call<M extends HostMethod>(
    method: M,
    params: HostMethods[M],
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) {
      throw new PluginError(`plugin "${this.name}" was disposed`);
    }
    if (this.dead) throw this.dead;
    // Before `start()`, so an already-dead run does not spawn a process for a
    // call nobody is waiting for. A listener added to an aborted signal never
    // fires, which is why this cannot be left to the handler below.
    if (signal?.aborted) {
      throw new PluginError(
        `plugin "${this.name}" was not called: the run was already over`,
      );
    }

    this.start();

    const id = this.nextId++;
    const timeout = this.options.timeout ?? DEFAULT_CALL_TIMEOUT;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.abandon(
          id,
          new PluginError(
            `plugin "${this.name}" did not answer ${method} within ${timeout}ms`,
          ),
        );
      }, timeout);

      const onAbort = (): void => {
        this.abandon(
          id,
          new PluginError(
            `plugin "${this.name}" was still in ${method} when the run ended`,
          ),
        );
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve,
        reject,
        release: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
        },
      });
      this.write({ id, method, params });
    });
  }

  /**
   * Give up on one outstanding call and kill the process behind it.
   *
   * Both ways in — the call's own timer, and the run being aborted — leave the
   * channel ambiguous: the plugin may be mid-reply, and a late response would
   * be matched to nothing. The kill is what makes giving up safe, and on the
   * abort path it is also the only thing that stops a plugin's process from
   * outliving the request that stopped waiting for it.
   */
  private abandon(id: number, err: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.release();
    this.kill();
    pending.reject(err);
  }

  private start(): void {
    if (this.proc) return;

    const launch = this.resolveCommand();

    let proc: ChildProcess;
    try {
      proc = spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: launch.cwd,
        env: launch.env,
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

  /**
   * How to spawn the plugin, confined by the sandbox when one was supplied.
   *
   * The whole `SandboxCommand` is carried through, not just its argv. Backends
   * do not agree on where the confined process's environment lives: bubblewrap
   * re-emits it as `--setenv` pairs inside `args`, seatbelt returns it in `env`
   * and nowhere else. Taking argv alone therefore looked correct on Linux and
   * started every macOS `--safe` plugin with a literally empty environment — no
   * PATH, no HOME — and stranded the scratch directory `cleanup` releases.
   */
  private resolveCommand(): {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd?: string;
  } {
    const { command, session, env, cwd } = this.options;
    const [executable, ...args] = command;

    // Empty by default. A plugin that needs a variable is given it explicitly;
    // nothing arrives just because heddle happened to have it.
    if (!session) return { command: executable, args, env: env ?? {}, cwd };

    // Program and arguments stay separate: a sandbox binds the *program* it is
    // given into the confined filesystem and nothing else, so a joined command
    // line would name a program that does not exist on the other side.
    const wrapped = session.wrap(executable, args);
    this.cleanupSandbox = wrapped.cleanup;

    // The backend's env is the floor the confined process needs to start at
    // all; what the caller named is a decision, so it wins over the floor.
    return {
      command: wrapped.command,
      args: wrapped.args,
      env: { ...wrapped.env, ...env },
      cwd: wrapped.cwd ?? cwd,
    };
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

    if (!isPluginMethod(request.method)) {
      respond({
        error: {
          name: 'PluginError',
          message:
            `heddle does not serve "${request.method}". ` +
            `It serves: ${PLUGIN_METHODS.join(', ')}.`,
        },
      });
      return;
    }

    // Checked before the call is dispatched, not inside the handler, so a
    // capability cannot be added later with its gate accidentally left out —
    // and so an ungranted call has no effect at all, rather than one that got
    // partway before something noticed.
    if (!this.granted.has(request.method)) {
      respond({
        error: {
          name: 'PluginError',
          message:
            `"${request.method}" is not granted to this plugin. ` +
            `Add it to "capabilities" in the manifest: a plugin gets only what it ` +
            `declares, and whether the host allows it is settled when the plugin ` +
            `loads rather than here.`,
        },
      });
      return;
    }

    switch (request.method) {
      case 'runTool':
        await this.serveRunTool(request, respond);
        return;
    }

    // Unreachable: the guard above accepts exactly the methods this switch
    // handles, both derived from one list. Writing the fallthrough out anyway
    // is what makes the switch exhaustive — `unserved` takes `never`, so a
    // method added to `PluginMethod` without a case here fails to compile
    // instead of leaving the plugin that called it waiting for a reply.
    respond({ error: { name: 'PluginError', message: unserved(request.method) } });
  }

  private async serveRunTool(
    request: RpcRequest,
    respond: (response: Omit<RpcResponse, 'id'>) => void,
  ): Promise<void> {
    // A different condition from the grant above, and it has to keep saying so.
    // Here the plugin asked for runTool and was allowed it; what is missing is
    // the runner, which `createExecutor` and `createTransform` install from the
    // compiled graph's dependencies. Reaching this means the plugin's process
    // was called without either of those running first, so it is heddle's
    // wiring at fault and not the manifest — a message about capabilities would
    // send the author to change a file that is already correct.
    if (!this.toolRunner) {
      respond({
        error: {
          name: 'PluginError',
          message:
            'runTool is granted to this plugin, but no tool runner was installed on ' +
            'it. A plugin reaches the flow tools through the executor built for its ' +
            'component, and nothing built one here.',
        },
      });
      return;
    }

    const params = (request.params ?? {}) as Partial<RunToolParams>;
    if (typeof params.name !== 'string' || params.name.length === 0) {
      respond({
        error: {
          name: 'PluginError',
          message: 'runTool needs a "name": the tool to run, as the flow registered it',
        },
      });
      return;
    }

    try {
      const result = await this.toolRunner(params.name, params.input ?? {});
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
    pending.release();

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
      pending.release();
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
    // The sandbox allocated a scratch directory per wrapped invocation. A
    // plugin's process is wrapped once and lives for the run, so this is the
    // only point at which the directory can go — without it a server under
    // --safe grows a heddle-scratch-* directory per plugin per run, forever.
    this.cleanupSandbox?.();
    this.cleanupSandbox = undefined;
  }
}
