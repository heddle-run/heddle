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
import { EVENT_CONTRACT_VERSION } from '../runner/events.js';
import type { AfterAction } from './seams.js';
import type { ModelCaller, ToolRunner } from './services.js';
import type { PluginReporter } from './types.js';

const DEFAULT_CALL_TIMEOUT = 30_000;
const CANCEL_GRACE = 500;
const SHUTDOWN_GRACE = 1_000;
const STDERR_LIMIT = 4096;
const MAX_REPORTED_LINE = 200;

export type { ModelCaller, ToolRunner } from './services.js';

export type PartialHandler = (partial: unknown) => void;

export interface PluginHostOptions {
  command: string[];
  cwd?: string;
  timeout?: number;
  session?: SandboxSession;
  env?: Record<string, string>;
  capabilities?: PluginCapability[];
  seams?: Record<string, AfterAction[]>;
  runTool?: ToolRunner;
}

export interface CallOptions {
  signal?: AbortSignal;
  onPartial?: PartialHandler;
  reporter?: PluginReporter;
  runTool?: ToolRunner;
  callModel?: ModelCaller;
}

type Respond = (response: Omit<RpcResponse, 'id'>) => void;

interface LaunchCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  release: () => void;
  extend?: () => void;
  serving?: () => () => void;
  onPartial?: PartialHandler;
  reporter?: PluginReporter;
  toolRunner?: ToolRunner;
  modelCaller?: ModelCaller;
  lifecycle?: true;
}

export class PluginHost {
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new LineDecoder();
  private readonly granted: ReadonlySet<PluginCapability>;
  private proc?: ChildProcess;
  private nextId = 1;
  private stderr = '';
  private disposed = false;
  private toolRunner?: ToolRunner;
  private dead?: Error;
  private cleanupSandbox?: () => void;

  constructor(
    private readonly name: string,
    private readonly options: PluginHostOptions,
  ) {
    this.toolRunner = options.runTool;
    this.granted = new Set(options.capabilities ?? []);
  }

  get confined(): boolean {
    return this.options.session !== undefined;
  }

  setToolRunner(run: ToolRunner): void {
    this.toolRunner ??= run;
  }

  async call<M extends HostMethod>(
    method: M,
    params: HostMethods[M],
    options: CallOptions = {},
  ): Promise<unknown> {
    this.assertCallable(method, options.signal);
    this.start();

    const id = this.nextId++;
    const timeout = this.options.timeout ?? DEFAULT_CALL_TIMEOUT;

    return new Promise<unknown>((resolve, reject) => {
      const clock = this.newCallClock(id, method, timeout);
      const abortWatch = this.watchAbort(id, method, options.signal);

      this.pending.set(id, {
        resolve,
        reject,
        release: () => {
          clock.stop();
          abortWatch.stop();
        },
        extend: clock.restart,
        serving: clock.hold,
        onPartial: options.onPartial,
        reporter: options.reporter,
        toolRunner: options.runTool,
        modelCaller: options.callModel,
      });

      this.write({ id, method, params });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    const proc = this.proc;
    const alreadyGone = this.dead !== undefined;

    this.die(new PluginError(`plugin "${this.name}" was disposed`));
    this.proc = undefined;

    if (proc && !alreadyGone) this.stopProcess(proc);
    else proc?.kill('SIGKILL');

    this.cleanupSandbox?.();
    this.cleanupSandbox = undefined;
  }

  private assertCallable(method: string, signal: AbortSignal | undefined): void {
    if (this.disposed) {
      throw new PluginError(`plugin "${this.name}" was disposed`);
    }
    if (this.dead) throw this.dead;
    if (signal?.aborted) {
      throw new PluginError(
        `plugin "${this.name}" was not called: the run was already over`,
      );
    }
  }

  private newCallClock(
    id: number,
    method: string,
    timeout: number,
  ): { restart: () => void; hold: () => () => void; stop: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let holds = 0;
    let over = false;

    const arm = (): void => {
      clearTimeout(timer);
      timer =
        over || holds > 0
          ? undefined
          : setTimeout(() => {
              this.abandon(
                id,
                new PluginError(
                  `plugin "${this.name}" did not answer ${method} within ${timeout}ms`,
                ),
              );
            }, timeout);
    };
    arm();

    return {
      restart: arm,
      hold: () => {
        holds++;
        arm();

        let released = false;
        return () => {
          if (released) return;
          released = true;
          holds--;
          arm();
        };
      },
      stop: () => {
        over = true;
        arm();
      },
    };
  }

  private watchAbort(
    id: number,
    method: string,
    signal: AbortSignal | undefined,
  ): { stop: () => void } {
    const onAbort = (): void => {
      this.abandon(
        id,
        new PluginError(
          `plugin "${this.name}" was still in ${method} when the run ended`,
        ),
      );
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    return { stop: () => signal?.removeEventListener('abort', onAbort) };
  }

  private abandon(id: number, err: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;

    this.pending.delete(id);
    pending.release();
    pending.reject(err);
    this.cancelRemotely(id);
  }

  private cancelRemotely(abandoned: number): void {
    const proc = this.proc;
    if (!proc || this.dead) return;

    const id = this.nextId++;
    const kill = setTimeout(() => {
      this.pending.delete(id);
      proc.kill('SIGKILL');
    }, CANCEL_GRACE);

    this.pending.set(id, {
      resolve: () => clearTimeout(kill),
      reject: () => {
        clearTimeout(kill);
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

    const proc = this.spawnProcess(this.resolveCommand());
    this.proc = proc;

    proc.stdout?.setEncoding('utf-8');
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of this.decoder.push(chunk)) this.receive(line);
    });

    proc.stderr?.setEncoding('utf-8');
    proc.stderr?.on('data', (chunk: string) => this.recordStderr(chunk));

    proc.on('error', (err) =>
      this.die(
        new PluginError(`plugin "${this.name}" failed to run: ${err.message}`, {
          cause: err,
        }),
      ),
    );

    proc.on('close', (code, signal) =>
      this.die(new PluginError(this.exitMessage(code, signal))),
    );

    proc.stdin?.on('error', ignoreBrokenPipe);

    this.greet();
  }

  private spawnProcess(launch: LaunchCommand): ChildProcess {
    try {
      return spawn(launch.command, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: launch.cwd,
        env: launch.env,
      });
    } catch (err) {
      throw new PluginError(`failed to start plugin "${this.name}"`, {
        cause: err,
      });
    }
  }

  private resolveCommand(): LaunchCommand {
    const { command, session, env, cwd } = this.options;
    const [executable, ...args] = command;

    if (!session) return { command: executable, args, env: env ?? {}, cwd };

    const wrapped = session.wrap(executable, args);
    this.cleanupSandbox = wrapped.cleanup;

    return {
      command: wrapped.command,
      args: wrapped.args,
      env: { ...wrapped.env, ...env },
      cwd: wrapped.cwd ?? cwd,
    };
  }

  private recordStderr(chunk: string): void {
    if (this.stderr.length >= STDERR_LIMIT) return;
    this.stderr = (this.stderr + chunk).slice(0, STDERR_LIMIT);
  }

  private exitMessage(code: number | null, signal: string | null): string {
    const how = signal ? `signal ${signal}` : `exit code ${code}`;
    const detail = this.stderr ? `: ${this.stderr.trim()}` : '';
    return `plugin "${this.name}" exited (${how})${detail}`;
  }

  private greet(): void {
    const id = this.nextId++;

    this.pending.set(id, {
      resolve: (result) => this.checkProtocol(result),
      reject: () => {
        if (!this.dead && !this.disposed) this.checkProtocol(undefined);
      },
      release: () => {},
      lifecycle: true,
    });

    this.write(
      hostRequest(id, 'init', {
        protocol: PROTOCOL_VERSION,
        events: EVENT_CONTRACT_VERSION,
        capabilities: [...this.granted],
        ...(this.options.seams ? { seams: this.options.seams } : {}),
      }),
    );
  }

  private checkProtocol(result: unknown): void {
    const spoken = spokenProtocol(result);
    if (spoken === PROTOCOL_VERSION) return;

    this.die(new PluginError(protocolMismatchMessage(this.name, spoken)));
    this.proc?.kill('SIGKILL');
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
      this.die(new PluginError(nonJsonLineMessage(this.name, line)));
      return;
    }

    if (isPartial(message)) {
      this.progress(message);
      return;
    }
    if (isRequest(message)) {
      void this.serve(message);
      return;
    }
    if (!isObject(message)) {
      this.die(new PluginError(nonFrameMessage(this.name, line)));
      return;
    }

    this.settle(message);
  }

  private progress(frame: RpcPartial): void {
    const id = idOf(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;

    pending.extend?.();

    try {
      pending.onPartial?.(frame.partial);
    } catch (err) {
      this.abandon(
        id,
        err instanceof Error ? err : new PluginError(String(err)),
      );
    }
  }

  private async serve(request: RpcRequest): Promise<void> {
    const respond: Respond = (response) =>
      this.write({ id: request.id, ...response });

    if (!isPluginMethod(request.method)) {
      respond(
        refuse(
          `heddle does not serve "${request.method}". ` +
            `It serves: ${PLUGIN_METHODS.join(', ')}.`,
        ),
      );
      return;
    }

    if (!this.granted.has(request.method)) {
      respond(refuse(ungrantedMessage(request.method)));
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

    respond(refuse(unserved(request.method)));
  }

  private async serveRunTool(
    request: RpcRequest,
    respond: Respond,
  ): Promise<void> {
    const runner = this.runningToolsFor(request);
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
        refuse(
          'runTool needs a "name": the tool to run, as the flow registered it',
        ),
      );
      return;
    }

    const resume = this.holdClockFor(request);
    try {
      respond({ result: await runner(params.name, params.input ?? {}) });
    } catch (err) {
      respond(failure(err));
    } finally {
      resume();
    }
  }

  private async serveCallModel(
    request: RpcRequest,
    respond: Respond,
  ): Promise<void> {
    const call = namedCall(request);
    if (call === undefined) {
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
      respond(refuse(noSuchCallMessage(call)));
      return;
    }
    if (!pending.modelCaller) {
      respond(refuse(noModelWiredMessage(call)));
      return;
    }

    const resume = pending.serving?.() ?? noop;
    try {
      const response = await pending.modelCaller(
        readModelRequest(request.params),
      );
      respond({ result: response });
    } catch (err) {
      respond(failure(err));
    } finally {
      resume();
    }
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
      reporter.emitEvent(params.name, params.data);
      respond({ result: {} });
    } catch (err) {
      respond(failure(err));
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
            "carries the plugin's own shape.",
        ),
      );
      return;
    }

    try {
      reporter.log(params.level, params.message);
      respond({ result: {} });
    } catch (err) {
      respond(failure(err));
    }
  }

  private runningToolsFor(request: RpcRequest): ToolRunner | undefined {
    const call = namedCall(request);
    if (call === undefined) return this.toolRunner;

    return this.pending.get(idOf(call))?.toolRunner ?? this.toolRunner;
  }

  private holdClockFor(request: RpcRequest): () => void {
    const call = namedCall(request);
    if (call === undefined) return noop;

    return this.pending.get(idOf(call))?.serving?.() ?? noop;
  }

  private reportingTo(
    verb: 'emitEvent' | 'log',
    request: RpcRequest,
    respond: Respond,
  ): PluginReporter | undefined {
    const call = namedCall(request);
    if (call === undefined) {
      respond(refuse(reportWithoutCallMessage(verb)));
      return undefined;
    }

    const pending = this.pending.get(idOf(call));
    if (!pending) {
      respond(refuse(reportForEndedCallMessage(verb, call)));
      return undefined;
    }

    pending.extend?.();

    if (pending.lifecycle) {
      respond(refuse(reportOnLifecycleMessage(verb, call)));
      return undefined;
    }
    if (!pending.reporter) {
      respond(refuse(noReporterWiredMessage(verb, call)));
      return undefined;
    }

    return pending.reporter;
  }

  private settle(response: RpcResponse): void {
    const id = idOf(response.id);
    const pending = this.pending.get(id);
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

  private die(err: Error): void {
    if (this.dead) return;
    this.dead = err;

    this.settleTrailingLine();

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.release();
      pending.reject(err);
    }
  }

  private settleTrailingLine(): void {
    const leftover = this.decoder.flush();
    if (!leftover) return;

    try {
      this.settle(JSON.parse(leftover) as RpcResponse);
    } catch {
      return;
    }
  }

  private stopProcess(proc: ChildProcess): void {
    const kill = setTimeout(() => proc.kill('SIGKILL'), SHUTDOWN_GRACE);
    proc.once('close', () => clearTimeout(kill));

    try {
      if (proc.stdin?.writable) {
        proc.stdin.write(encode(hostRequest(this.nextId++, 'shutdown', {})));
        proc.stdin.end();
      }
    } catch {
      return;
    }
  }
}

function namedCall(request: RpcRequest): number | string | undefined {
  const { call } = (request.params ?? {}) as { call?: unknown };
  return typeof call === 'number' || typeof call === 'string'
    ? call
    : undefined;
}

function idOf(id: number | string): number {
  return typeof id === 'number' ? id : Number(id);
}

function refuse(message: string): Omit<RpcResponse, 'id'> {
  return { error: { name: 'PluginError', message } };
}

function failure(err: unknown): Omit<RpcResponse, 'id'> {
  return {
    error: {
      name: err instanceof Error ? err.name : 'Error',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

function unserved(method: never): string {
  return `heddle declares "${String(method)}" but does not serve it`;
}

function noop(): void {
  return;
}

function ignoreBrokenPipe(): void {
  return;
}

function protocolMismatchMessage(name: string, spoken: number): string {
  return (
    `plugin "${name}" speaks plugin protocol version ${spoken}, and this ` +
    `heddle speaks ${PROTOCOL_VERSION}. The two are not interchangeable — each ` +
    `side sends frames the other has no rule for. Rebuild the plugin against ` +
    `protocol ${PROTOCOL_VERSION}, or run it on a heddle that speaks ${spoken}.`
  );
}

function nonJsonLineMessage(name: string, line: string): string {
  return (
    `plugin "${name}" wrote a line that is not JSON. ` +
    `Logs belong on stderr; stdout carries the protocol. Got: ${line.slice(0, MAX_REPORTED_LINE)}`
  );
}

function nonFrameMessage(name: string, line: string): string {
  return (
    `plugin "${name}" wrote JSON that is not a protocol frame. ` +
    `Every frame is an object carrying an "id". Got: ${line.slice(0, MAX_REPORTED_LINE)}`
  );
}

function ungrantedMessage(method: string): string {
  return (
    `"${method}" is not granted to this plugin. ` +
    `Add it to "capabilities" in the manifest: a plugin gets only what it ` +
    `declares, and whether the host allows it is settled when the plugin ` +
    `loads rather than here.`
  );
}

function noSuchCallMessage(call: number | string): string {
  return (
    `callModel named call ${String(call)}, which is not an execute or apply ` +
    `heddle is waiting on. It has already been answered, timed out, been ` +
    `cancelled, or is a lifecycle frame that nothing runs under.`
  );
}

function noModelWiredMessage(call: number | string): string {
  return (
    `callModel is granted to this plugin, but call ${String(call)} was made ` +
    `with no model to call. A plugin reaches the model through the executor ` +
    `built for its component, and nothing built one here.`
  );
}

function reportWithoutCallMessage(verb: string): string {
  return (
    `${verb} needs a "call": the id of the execute or apply request it was ` +
    `made inside. heddle files a report under the node that call is ` +
    `running, so one naming no call has nothing to file it under.`
  );
}

function reportForEndedCallMessage(
  verb: string,
  call: number | string,
): string {
  return (
    `${verb} named call ${String(call)}, which heddle is not waiting on. A ` +
    `report belongs to the execute or apply it was made inside, and that ` +
    `one has already been answered, timed out, or been cancelled.`
  );
}

function reportOnLifecycleMessage(verb: string, call: number | string): string {
  return (
    `${verb} named call ${String(call)}, which is not an execute or apply. A ` +
    `report belongs to the call it was made inside; that id is a lifecycle ` +
    `frame heddle sent the plugin, and nothing runs under it.`
  );
}

function noReporterWiredMessage(verb: string, call: number | string): string {
  return (
    `${verb} is granted to this plugin, but call ${String(call)} was made ` +
    `with nowhere to report to. A plugin reports through the executor ` +
    `built for its component, and nothing built one here.`
  );
}
