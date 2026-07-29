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
  hostRequest,
  isLogLevel,
  isObject,
  isPartial,
  isPluginMethod,
  isRequest,
  LineDecoder,
  LOG_LEVELS,
  PLUGIN_METHODS,
  PROTOCOL_VERSION,
  readModelRequest,
  spokenProtocol,
  type EmitEventParams,
  type HostMethod,
  type HostMethods,
  type LogParams,
  type PluginCapability,
  type RpcMessage,
  type RpcPartial,
  type RpcRequest,
  type RpcResponse,
  type RunToolParams,
} from './protocol.js';
import type { AfterAction } from './seams.js';
import type { ModelCaller, ToolRunner } from './services.js';
import type { PluginReporter } from './types.js';

const DEFAULT_CALL_TIMEOUT = 30_000;

/**
 * How long a plugin has to acknowledge `cancel` before it is killed instead.
 *
 * Short on purpose. Nothing is waiting on the answer — the call it refers to is
 * already rejected — so this is only the delay between giving up on a plugin
 * and destroying it, and the plugin that most needs cancelling is the one least
 * likely to reply.
 */
const CANCEL_GRACE = 500;

/**
 * How long a plugin has to exit after `shutdown` before SIGKILL.
 *
 * Longer than {@link CANCEL_GRACE} because there is real work behind it — a
 * connection pool to drain, a file to flush — and because a plugin that is
 * going to exit cleanly does so at once, so the full second is only ever paid
 * by one that would have been killed anyway.
 */
const SHUTDOWN_GRACE = 1_000;

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
   * The verdicts each seam this plugin subscribed to admits, sent with the
   * handshake. Absent for a plugin that provides no middleware.
   */
  seams?: Record<string, AfterAction[]>;
  /**
   * Serves the plugin's `runTool` calls.
   *
   * Usually supplied later with {@link PluginHost.setToolRunner}: a host is
   * built when the plugin loads, but the tool registry it would call into only
   * exists once a flow is compiled.
   */
  runTool?: ToolRunner;
}

export type { ModelCaller, ToolRunner } from './services.js';

/** Names a declared reverse call that has no implementation. See {@link PluginHost.serve}. */
function unserved(method: never): string {
  return `heddle declares "${String(method)}" but does not serve it`;
}

/** A callback that consumes one `{ id, partial }` frame. See {@link PluginHost.call}. */
export type PartialHandler = (partial: unknown) => void;

/**
 * Everything about one call that is not the call itself.
 *
 * All optional, and a call made with none of them still runs — the plugin is
 * told, in each verb's own terms, what it has nowhere to reach. See
 * {@link PluginHost.call} for what each one buys.
 */
export interface CallOptions {
  signal?: AbortSignal;
  onPartial?: PartialHandler;
  reporter?: PluginReporter;
  runTool?: ToolRunner;
  callModel?: ModelCaller;
}

/** Answers one request the plugin made, on that request's own id. */
type Respond = (response: Omit<RpcResponse, 'id'>) => void;

/** An error frame, in the one shape every refusal below takes. */
function refuse(message: string): Omit<RpcResponse, 'id'> {
  return { error: { name: 'PluginError', message } };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** Cancels the call's timer and its abort listener, however it ends. */
  release: () => void;
  /**
   * Restarts the call's timeout. Absent on the host's own lifecycle frames,
   * which carry their own deadline or none at all.
   */
  extend?: () => void;
  /**
   * Suspends the call's timeout while heddle is serving a request the plugin
   * made, returning the function that resumes it.
   *
   * The budget measures a plugin's silence, and a plugin blocked on `callModel`
   * or `runTool` is not silent — it is waiting on heddle, which knows exactly
   * how long it has kept it waiting. Without this, a plugin's deadline is
   * really a deadline on heddle's own work: a 30-second per-call budget and a
   * 45-second model call kill a plugin that did nothing wrong, and the error
   * says it never answered.
   *
   * A hold cannot be gamed into forever. It is taken by the host around a call
   * it is itself making, released in a `finally`, and nested holds count — so
   * the timer restarts when the last one ends and a plugin firing ten `runTool`
   * calls buys exactly the time those ten take.
   */
  serving?: () => () => void;
  onPartial?: PartialHandler;
  /**
   * Publishes what the plugin reports while this call is running.
   *
   * Held per call rather than per host, because it carries the attribution: one
   * process serves every component of a plugin, so a single reporter on the
   * host would file node B's events under node A the moment two calls overlap.
   * A reverse call names the call it came from and the host looks the reporter
   * up here, which is also why a plugin cannot choose the namespace its events
   * are published under — it was fixed when heddle dispatched the call.
   */
  reporter?: PluginReporter;
  /**
   * Runs this call's tools, in the scope heddle opened for it.
   *
   * Per call for a stronger reason than the reporter's. The host's own runner
   * is scopeless, so every tool it starts gets a throwaway sandbox session — a
   * different workspace from the one `ExecuteParams.workspace` named. A plugin
   * that writes a file and passes its path to `runTool` would then hand the
   * tool a path that is not there, and it would read as the tool being broken.
   */
  toolRunner?: ToolRunner;
  /**
   * Calls the model on this component's behalf, on the config its spec names.
   *
   * Per call and with no host-wide fallback, which is the difference from
   * {@link toolRunner}. A tool registry is one thing for the whole flow, so a
   * scopeless runner is a worse answer but an answer. A model config belongs to
   * the *component* — one plugin's judge node and its summarizer transform can
   * name different models, and a plugin serves both from one process — so there
   * is no host-wide model that would be right, and a call that names no
   * `execute` or `apply` is refused rather than sent somewhere plausible.
   */
  modelCaller?: ModelCaller;
  /**
   * Marks a frame heddle sent on its own behalf — `init` or `cancel` — rather
   * than a call anything is running under.
   *
   * These sit in the same map as real calls, so their ids are guessable: `init`
   * is always 1. Without this marker a plugin that never answers `init` and
   * then reports against call 1 gets heddle's "nothing built an executor here"
   * message, which blames heddle's own wiring for a frame the plugin forged and
   * sends whoever reads it into plumbing that is working correctly.
   */
  lifecycle?: true;
}

/** Ids arrive as whatever the plugin echoed; the host issues only numbers. */
function idOf(id: number | string): number {
  return typeof id === 'number' ? id : Number(id);
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
   * Whether this plugin's process runs inside a sandbox session of its own.
   *
   * Read by `remoteNodeDef` to decide whether the node's workspace path means
   * anything on the plugin's side of the boundary. It does not, when this is
   * true: the two are different sessions, and confinement is fixed at spawn —
   * see `ExecuteParams.workspace`.
   */
  get confined(): boolean {
    return this.options.session !== undefined;
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
   *
   * `onPartial` receives each `{ id, partial }` frame the plugin sends for this
   * call. Nothing in heddle emits one yet; the parameter exists so the consumer
   * side of the frame is settled at the same time as the frame, rather than
   * being the reason `call`'s signature changes once plugins depend on it.
   *
   * `reporter` is what the plugin's `emitEvent` and `log` land on for the
   * duration of this call. Passed in rather than built here on purpose: the
   * caller hands over the very object an in-process plugin would have been
   * given, so the remote path publishes the same events by construction instead
   * of by a second implementation that has to be kept identical. A call made
   * without one still runs; the plugin is told there is nowhere to report to.
   *
   * `runTool` is the same trade for the plugin's tool calls, and it is what
   * keeps this call's tools inside this call's scope. Both callers have one now:
   * a node hands over the runner bound to the tool scope it opened, so the tool
   * runs in the session whose workspace the plugin was told about, and a
   * transform hands over the scopeless one it would have used in process. What
   * is left behind {@link setToolRunner} is the single case that can pass
   * nothing — a plugin hand-rolling the protocol without a `call` id.
   *
   * `callModel` is the same trade again, with no fallback behind it at all: see
   * `Pending.modelCaller`.
   *
   * The four of them arrive in an object rather than as trailing positional
   * arguments. Two are callbacks and two are functions taking a name and an
   * object, so a transposed pair is a plausible mistake with a plausible-
   * looking type, and the roadmap has more of them coming.
   */
  async call<M extends HostMethod>(
    method: M,
    params: HostMethods[M],
    options: CallOptions = {},
  ): Promise<unknown> {
    const { signal, onPartial, reporter, runTool, callModel } = options;
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
      const expire = (): void => {
        this.abandon(
          id,
          new PluginError(
            `plugin "${this.name}" did not answer ${method} within ${timeout}ms`,
          ),
        );
      };

      // One place decides whether this call has a running clock, because there
      // are now three inputs to that — the call ended, heddle is serving a
      // request from inside it, or the plugin said something — and three
      // separate `clearTimeout`/`setTimeout` pairs would eventually disagree.
      // A hold that outlives its call is the specific failure: `over` is what
      // stops a release arriving after the answer from arming a timer for a
      // call nobody is waiting on, which would hold the event loop open for a
      // whole timeout after the run finished.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let holds = 0;
      let over = false;
      const arm = (): void => {
        clearTimeout(timer);
        timer = over || holds > 0 ? undefined : setTimeout(expire, timeout);
      };
      arm();

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
          over = true;
          arm();
          signal?.removeEventListener('abort', onAbort);
        },
        // The timeout is a silence budget, not a total budget. Measured from
        // the request it would kill a plugin that has been answering all along
        // — a token stream, a long tool loop reporting progress — and report it
        // as one that never answered.
        extend: arm,
        serving: () => {
          holds++;
          arm();
          let released = false;
          return () => {
            // Idempotent, because the caller releases in a `finally` and a
            // second release would decrement a count it does not own — leaving
            // a concurrent hold's call permanently unarmed.
            if (released) return;
            released = true;
            holds--;
            arm();
          };
        },
        onPartial,
        reporter,
        toolRunner: runTool,
        modelCaller: callModel,
      });
      this.write({ id, method, params });
    });
  }

  /**
   * Give up on one outstanding call and deal with the process behind it.
   *
   * Both ways in — the call's own timer, and the run being aborted — leave the
   * channel ambiguous: the plugin may be mid-reply, and a late response would
   * be matched to nothing. Settling that ambiguity is what makes giving up
   * safe: either the plugin says it has dropped the call, or it is destroyed.
   * {@link cancelRemotely} is where those two meet, and it ends in the second
   * unless the plugin actively chooses the first.
   *
   * The rejection happens first and unconditionally, before anything is
   * attempted on the process. Whatever {@link cancelRemotely} manages or fails
   * to manage, the caller's promise is already settled — a graceful path that
   * hangs cannot turn a failed call into a pending one.
   */
  private abandon(id: number, err: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.release();
    pending.reject(err);
    this.cancelRemotely(id);
  }

  /**
   * Ask the plugin to drop an abandoned call, and kill it if it will not.
   *
   * Killing outright — what this path used to do — is correct and expensive. It
   * costs the plugin any chance to close a connection or unlink a temp file,
   * and it costs the run the process, so the next node reaching the same plugin
   * pays a spawn to get one back. A `cancel` frame buys both back from a plugin
   * willing to answer it, which is the only kind worth keeping.
   *
   * The kill is armed *before* the frame is written, and the one thing that
   * disarms it is a reply on the cancel's own id. A plugin that does not
   * implement `cancel`, refuses it, ignores it, or dies while thinking about it
   * is killed exactly as it was before — {@link CANCEL_GRACE} later, which is
   * the whole of what this costs when it does not work.
   */
  private cancelRemotely(abandoned: number): void {
    const proc = this.proc;
    // Nothing to negotiate with: the process is already gone, and `die` has
    // reported why to everything that was waiting.
    if (!proc || this.dead) return;

    const id = this.nextId++;
    const kill = setTimeout(() => {
      this.pending.delete(id);
      proc.kill('SIGKILL');
    }, CANCEL_GRACE);

    this.pending.set(id, {
      // Acknowledged. The plugin says the call is dropped, so its process is
      // idle and may serve the next one.
      resolve: () => clearTimeout(kill),
      // Refused, unknown, or the process died under us. Either way there is
      // nothing left to wait for.
      reject: () => {
        clearTimeout(kill);
        // Except when this rejection came from `dispose`. `dispose` sets the
        // flag, then calls `die`, which rejects every pending — including this
        // one — before it reaches `stopProcess`. Killing here would beat the
        // graceful stop to the process and skip it entirely, and it would do so
        // precisely when a call was abandoned in the last CANCEL_GRACE: the
        // case this whole path exists to handle well.
        if (this.disposed) return;
        proc.kill('SIGKILL');
      },
      release: () => {},
      lifecycle: true,
    });

    this.write(hostRequest(id, 'cancel', { call: abandoned }));
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

    this.greet();
  }

  /**
   * Announce heddle's protocol version, and tell the plugin what it was granted.
   *
   * Written first, so a plugin reading its stdin in order sees the handshake
   * before any work. Not *waited* for, and that is the deliberate part: making
   * the first call block on the answer would charge every plugin a round trip
   * for a check that, when it fails, fails that call anyway — and would report a
   * plugin whose handler never returns as "did not answer init", sending its
   * author to the handshake instead of to the handler. The version is checked
   * when the answer arrives, and a mismatch fails whatever is in flight.
   *
   * There is no timer here on purpose. An `init` that is never answered belongs
   * to a plugin that answers nothing, and the call behind it already has a
   * deadline that says so in the caller's own terms; a second one would only
   * race it to report the same failure less usefully.
   */
  private greet(): void {
    const id = this.nextId++;
    this.pending.set(id, {
      resolve: (result) => this.checkProtocol(result),
      // A plugin built before `init` existed answers "unknown method" — an
      // error frame, which lands here rather than on `resolve`. That is one of
      // the two silences {@link spokenProtocol} reads as UNVERSIONED, so it
      // goes through the same check as a result would: today that means it
      // passes, and the day PROTOCOL_VERSION moves past 1 it is reported as the
      // mismatch it has become. Swallowing it here instead would have made that
      // promise quietly unkeepable.
      //
      // Unless the process is already gone. Then `die` is rejecting every
      // pending at once, the reason is recorded, and "your plugin speaks the
      // wrong protocol" is the wrong thing to say about a corpse.
      reject: () => {
        if (!this.dead && !this.disposed) this.checkProtocol(undefined);
      },
      release: () => {},
      lifecycle: true,
    });

    this.write(
      hostRequest(id, 'init', {
        protocol: PROTOCOL_VERSION,
        capabilities: [...this.granted],
        ...(this.options.seams ? { seams: this.options.seams } : {}),
      }),
    );
  }

  /**
   * Fail the plugin when the two ends do not speak the same protocol.
   *
   * Reported here rather than left to surface on its own, because on its own it
   * surfaces as something else entirely: a verb the plugin has never heard of
   * comes back as its own "unknown method" from another process, and a frame
   * shape it does not produce comes back as a result that does not parse. Both
   * send the author looking at their handler. Naming both versions and the
   * plugin is the only form of this that points at the actual problem.
   */
  private checkProtocol(result: unknown): void {
    const spoken = spokenProtocol(result);
    if (spoken === PROTOCOL_VERSION) return;

    this.die(
      new PluginError(
        `plugin "${this.name}" speaks plugin protocol version ${spoken}, and this ` +
          `heddle speaks ${PROTOCOL_VERSION}. The two are not interchangeable — each ` +
          `side sends frames the other has no rule for. Rebuild the plugin against ` +
          `protocol ${PROTOCOL_VERSION}, or run it on a heddle that speaks ${spoken}.`,
      ),
    );
    this.kill();
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

    // Ahead of the response check, and that order is the point of the frame.
    // `settle` reads any non-request as an answer, and `{ id, partial }` has
    // neither `result` nor `error` — so routed there it would resolve the call
    // with `undefined` and the caller would be told the plugin returned nothing.
    if (isPartial(message)) {
      this.progress(message);
      return;
    }
    if (isRequest(message)) {
      void this.serve(message);
      return;
    }
    // `null`, a number, an array — valid JSON, and none of the three frames.
    // Named rather than ignored: a plugin emitting these is broken in a way its
    // author needs told, and `settle` would read `.id` off it and throw on the
    // stdout handler's stack, where nothing catches it.
    if (!isObject(message)) {
      this.die(
        new PluginError(
          `plugin "${this.name}" wrote JSON that is not a protocol frame. ` +
            `Every frame is an object carrying an "id". Got: ${line.slice(0, 200)}`,
        ),
      );
      return;
    }
    this.settle(message);
  }

  /** Take one partial: keep the call open, and keep its clock honest. */
  private progress(frame: RpcPartial): void {
    const id = idOf(frame.id);
    const pending = this.pending.get(id);
    // Same reasoning as a late response: a partial for a call that has already
    // ended belongs to nobody, and is not worth failing a plugin over.
    if (!pending) return;

    pending.extend?.();

    try {
      pending.onPartial?.(frame.partial);
    } catch (err) {
      // A consumer that threw is on the stdout handler's stack, where an escape
      // becomes an uncaught exception naming neither the plugin nor the call.
      // It ends the call the partial belonged to instead: a caller that cannot
      // take a piece of the answer has no use for the rest of it.
      this.abandon(id, err instanceof Error ? err : new PluginError(String(err)));
    }
  }

  /** Answer a request the plugin made of heddle. */
  private async serve(request: RpcRequest): Promise<void> {
    const respond: Respond = (response) => this.write({ id: request.id, ...response });

    if (!isPluginMethod(request.method)) {
      respond(
        refuse(
          `heddle does not serve "${request.method}". ` +
            `It serves: ${PLUGIN_METHODS.join(', ')}.`,
        ),
      );
      return;
    }

    // Checked before the call is dispatched, not inside the handler, so a
    // capability cannot be added later with its gate accidentally left out —
    // and so an ungranted call has no effect at all, rather than one that got
    // partway before something noticed.
    if (!this.granted.has(request.method)) {
      respond(
        refuse(
          `"${request.method}" is not granted to this plugin. ` +
            `Add it to "capabilities" in the manifest: a plugin gets only what it ` +
            `declares, and whether the host allows it is settled when the plugin ` +
            `loads rather than here.`,
        ),
      );
      return;
    }

    switch (request.method) {
      case 'runTool':
        await this.serveRunTool(request, respond);
        return;
      case 'emitEvent':
        this.serveEmitEvent(request, respond);
        return;
      case 'log':
        this.serveLog(request, respond);
        return;
      case 'callModel':
        await this.serveCallModel(request, respond);
        return;
    }

    // Unreachable: the guard above accepts exactly the methods this switch
    // handles, both derived from one list. Writing the fallthrough out anyway
    // is what makes the switch exhaustive — `unserved` takes `never`, so a
    // method added to `PluginMethod` without a case here fails to compile
    // instead of leaving the plugin that called it waiting for a reply.
    respond(refuse(unserved(request.method)));
  }

  /**
   * Which executor serves one `runTool`, preferring the calling node's own.
   *
   * A node opened a tool scope for its execution and handed the runner bound to
   * it to {@link call}, so a tool started through that one lands in the session
   * whose workspace the plugin was told about — the property
   * `PluginContext.getWorkspace` promises and the reason a plugin can hand a
   * tool a 200 MB file at all.
   *
   * Falls back to the host-wide runner in the two cases where there is no
   * better answer, rather than refusing: a transform, which owns no scope and
   * never had one, and a plugin that hand-rolls the protocol and sends no
   * `call` — written before this field existed, and still entitled to run a
   * tool. Both get what they got before, which is a throwaway session per call.
   */
  private runningToolsFor(request: RpcRequest): ToolRunner | undefined {
    const { call } = (request.params ?? {}) as { call?: unknown };
    if (typeof call !== 'number' && typeof call !== 'string') return this.toolRunner;
    return this.pending.get(idOf(call))?.toolRunner ?? this.toolRunner;
  }

  /**
   * Stop the clock on the call a reverse call was made inside, for as long as
   * heddle is serving it.
   *
   * Every reverse call heddle *blocks* on takes one of these. `emitEvent` and
   * `log` do not: they return immediately, and what they need is the opposite —
   * a restart, because the plugin spoke. This is for the case where the plugin
   * has stopped speaking precisely because it is waiting for heddle.
   *
   * Returns a no-op release when the frame names no call, or names one that has
   * already ended. Both are served anyway — a hand-rolled plugin may send no
   * `call` id — and neither has a clock left to hold.
   */
  private holdClockFor(request: RpcRequest): () => void {
    const { call } = (request.params ?? {}) as { call?: unknown };
    if (typeof call !== 'number' && typeof call !== 'string') return () => {};
    return this.pending.get(idOf(call))?.serving?.() ?? (() => {});
  }

  private async serveRunTool(request: RpcRequest, respond: Respond): Promise<void> {
    const runner = this.runningToolsFor(request);

    // A different condition from the grant above, and it has to keep saying so.
    // Here the plugin asked for runTool and was allowed it; what is missing is
    // the runner, which `createExecutor` and `createTransform` install from the
    // compiled graph's dependencies. Reaching this means the plugin's process
    // was called without either of those running first, so it is heddle's
    // wiring at fault and not the manifest — a message about capabilities would
    // send the author to change a file that is already correct.
    if (!runner) {
      respond(
        refuse(
          'runTool is granted to this plugin, but no tool runner was installed on ' +
            'it. A plugin reaches the flow tools through the executor built for its ' +
            'component, and nothing built one here.',
        ),
      );
      return;
    }

    const params = (request.params ?? {}) as Partial<RunToolParams>;
    if (typeof params.name !== 'string' || params.name.length === 0) {
      respond(
        refuse('runTool needs a "name": the tool to run, as the flow registered it'),
      );
      return;
    }

    // A tool can outlast the plugin's own per-call budget — that is what a tool
    // that shells out to something slow *is* — and the plugin waiting on it has
    // not gone quiet of its own accord.
    const resume = this.holdClockFor(request);
    try {
      const result = await runner(params.name, params.input ?? {});
      respond({ result });
    } catch (err) {
      respond({
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      resume();
    }
  }

  /**
   * Which model serves one `callModel`: the calling component's, or none.
   *
   * No fallback, unlike {@link runningToolsFor}. The config a model call goes
   * to belongs to the component whose `execute` or `apply` is running, so
   * "whichever one heddle happens to have" is not a worse answer here, it is a
   * request sent somewhere the flow's author did not ask for. A frame naming no
   * call, or one that has ended, gets an error saying which.
   */
  private async serveCallModel(request: RpcRequest, respond: Respond): Promise<void> {
    const { call } = (request.params ?? {}) as { call?: unknown };
    if (typeof call !== 'number' && typeof call !== 'string') {
      respond(
        refuse(
          'callModel needs a "call": the id of the execute or apply request it was ' +
            'made inside. The model a plugin reaches is the one its own component ' +
            'names, so a call belonging to no component has no model to reach.',
        ),
      );
      return;
    }

    const pending = this.pending.get(idOf(call));
    if (!pending || pending.lifecycle) {
      respond(
        refuse(
          `callModel named call ${String(call)}, which is not an execute or apply ` +
            `heddle is waiting on. It has already been answered, timed out, been ` +
            `cancelled, or is a lifecycle frame that nothing runs under.`,
        ),
      );
      return;
    }

    if (!pending.modelCaller) {
      // The same distinction `serveRunTool` draws, and it matters more here:
      // the plugin declared the capability and the host allowed it, so the
      // manifest is right and heddle's own wiring is what is missing.
      respond(
        refuse(
          `callModel is granted to this plugin, but call ${String(call)} was made ` +
            `with no model to call. A plugin reaches the model through the executor ` +
            `built for its component, and nothing built one here.`,
        ),
      );
      return;
    }

    // Taken before the request is even read, and held across the whole call:
    // this is the reverse call that most needs it. A model that takes 45
    // seconds against a 30-second per-call budget would otherwise kill a plugin
    // that is doing nothing but waiting on heddle, and report it as one that
    // never answered.
    const resume = pending.serving?.() ?? ((): void => {});
    try {
      const response = await pending.modelCaller(readModelRequest(request.params));
      respond({ result: response });
    } catch (err) {
      // Everything from here comes back as the plugin's own failed call: a
      // malformed frame, a missing `llm_config`, a refused credential, a 429.
      // The plugin decides what to do about it, exactly as an in-process one
      // decides what to do about the same throw.
      respond({
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    } finally {
      resume();
    }
  }

  /**
   * Find where a report goes, and keep the clock of the call it came from.
   *
   * A report names the `execute` or `apply` it was made inside, and that id is
   * the whole of how heddle attributes it — see `InFlight` in the protocol.
   * Three ways it comes back with nowhere to go, and each is a different
   * person's mistake, so each says something different: a plugin that named no
   * call, a plugin that named a call that is over, and a heddle that dispatched
   * a call without giving it anywhere to report to.
   */
  private reportingTo(
    verb: 'emitEvent' | 'log',
    request: RpcRequest,
    respond: Respond,
  ): PluginReporter | undefined {
    const { call } = (request.params ?? {}) as { call?: unknown };
    if (typeof call !== 'number' && typeof call !== 'string') {
      respond(
        refuse(
          `${verb} needs a "call": the id of the execute or apply request it was ` +
            `made inside. heddle files a report under the node that call is ` +
            `running, so one naming no call has nothing to file it under.`,
        ),
      );
      return undefined;
    }

    const pending = this.pending.get(idOf(call));
    if (!pending) {
      respond(
        refuse(
          `${verb} named call ${String(call)}, which heddle is not waiting on. A ` +
            `report belongs to the execute or apply it was made inside, and that ` +
            `one has already been answered, timed out, or been cancelled.`,
        ),
      );
      return undefined;
    }

    // Before the report is checked, not after. A plugin that says anything at
    // all has not hung, and whether it is alive does not depend on whether it
    // got the frame right. Same rule a partial runs under.
    pending.extend?.();

    // Ahead of the reporter check, because a lifecycle id is not a call that
    // lost its executor — it is a frame heddle sent the plugin, and its id is
    // guessable (`init` is always 1). Reported as "nothing built one here" it
    // would blame heddle's wiring for a plugin's forgery.
    if (pending.lifecycle) {
      respond(
        refuse(
          `${verb} named call ${String(call)}, which is not an execute or apply. A ` +
            `report belongs to the call it was made inside; that id is a lifecycle ` +
            `frame heddle sent the plugin, and nothing runs under it.`,
        ),
      );
      return undefined;
    }

    if (!pending.reporter) {
      // A different condition from the grant, exactly as the missing tool
      // runner is: the plugin asked and was allowed, and what is absent is
      // heddle's own wiring. Sending an author to the manifest here would send
      // them to change a file that is already correct.
      respond(
        refuse(
          `${verb} is granted to this plugin, but call ${String(call)} was made ` +
            `with nowhere to report to. A plugin reports through the executor ` +
            `built for its component, and nothing built one here.`,
        ),
      );
      return undefined;
    }

    return pending.reporter;
  }

  private serveEmitEvent(request: RpcRequest, respond: Respond): void {
    const reporter = this.reportingTo('emitEvent', request, respond);
    if (!reporter) return;

    const params = (request.params ?? {}) as Partial<EmitEventParams>;
    if (typeof params.name !== 'string') {
      respond(
        refuse(
          'emitEvent needs a "name": the plugin\'s half of the event type, which ' +
            'heddle publishes as plugin:<componentType>:<name>.',
        ),
      );
      return;
    }

    try {
      // The very call an in-process plugin makes, so the name check, the
      // namespacing and the published shape are one implementation instead of
      // two that have to be kept identical. It is also where the plugin's half
      // of the name is refused if it is not an identifier — the check that
      // stops an event name from carrying a frame of its own.
      reporter.emitEvent(params.name, params.data);
      respond({ result: {} });
    } catch (err) {
      // Reported back rather than allowed to escape. `serve` runs from the
      // stdout handler, so a throw here is an unhandled rejection naming
      // neither the plugin nor the event; answered, it is the plugin's own call
      // failing, which is what an in-process plugin gets for the same mistake.
      respond({
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private serveLog(request: RpcRequest, respond: Respond): void {
    const reporter = this.reportingTo('log', request, respond);
    if (!reporter) return;

    const params = (request.params ?? {}) as Partial<LogParams>;
    if (!isLogLevel(params.level)) {
      respond(
        refuse(
          `log needs a "level", one of: ${LOG_LEVELS.join(', ')}. Got ` +
            `${JSON.stringify(params.level)}.`,
        ),
      );
      return;
    }
    if (typeof params.message !== 'string') {
      respond(
        refuse(
          'log needs a "message": one line for a person watching the run. A ' +
            'structured payload belongs on emitEvent, which is the verb that ' +
            'carries the plugin\'s own shape.',
        ),
      );
      return;
    }

    try {
      reporter.log(params.level, params.message);
      respond({ result: {} });
    } catch (err) {
      // `log` cannot fail of itself, but the event handler behind it belongs to
      // whoever is watching the run — an SSE stream that has gone away, say —
      // and its failure must not become this process's uncaught exception.
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
    const id = idOf(response.id);
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
   * this is what stops one caller's code from outliving their request. It stays
   * synchronous for that reason — its caller is a `finally` that does not await
   * (`packages/server/src/runs.ts`), so anything that needed awaiting here would
   * be a teardown nobody waits for.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const proc = this.proc;
    // Read before `die` sets it, since `die` is how a dead process is recorded
    // and a corpse has nothing to say goodbye with.
    const alreadyGone = this.dead !== undefined;
    this.die(new PluginError(`plugin "${this.name}" was disposed`));
    this.proc = undefined;

    if (proc && !alreadyGone) this.stopProcess(proc);
    else proc?.kill('SIGKILL');

    // The sandbox allocated a scratch directory per wrapped invocation. A
    // plugin's process is wrapped once and lives for the run, so this is the
    // only point at which the directory can go — without it a server under
    // --safe grows a heddle-scratch-* directory per plugin per run, forever.
    this.cleanupSandbox?.();
    this.cleanupSandbox = undefined;
  }

  /**
   * Ask the plugin to stop, then make sure it did.
   *
   * `shutdown` and the closed stdin behind it are the whole of the graceful
   * path, and neither is trusted. The SIGKILL is armed before either is sent,
   * and the only thing that cancels it is the process actually ending — so a
   * plugin that implements neither dies exactly as it did before this existed,
   * {@link SHUTDOWN_GRACE} later. What it buys is the case that used to be
   * impossible: a plugin holding a connection pool or a half-written file gets
   * to close it instead of learning it is over from SIGKILL, which cannot be
   * caught.
   *
   * The timer is deliberately not `unref`'d. Teardown is the guarantee this
   * class exists for, and a timer node is free to skip on its way out is not a
   * guarantee — it would leave an uncooperative plugin orphaned rather than
   * killed.
   */
  private stopProcess(proc: ChildProcess): void {
    const kill = setTimeout(() => proc.kill('SIGKILL'), SHUTDOWN_GRACE);
    proc.once('close', () => clearTimeout(kill));

    try {
      if (proc.stdin?.writable) {
        // Not `this.write`: `dispose` has already cleared `this.proc`, and the
        // process it cleared is the one that has to be told.
        proc.stdin.write(encode(hostRequest(this.nextId++, 'shutdown', {})));
        // Ends a plugin that never learned the verb: closing stdin is what the
        // protocol has always documented as the end of a run, and it is what
        // every read-loop plugin — including the shell one in the tests — sees
        // as its cue to exit.
        proc.stdin.end();
      }
    } catch {
      // A broken pipe means the plugin is already on its way out. The kill
      // above covers the case where it is not.
    }
  }
}
