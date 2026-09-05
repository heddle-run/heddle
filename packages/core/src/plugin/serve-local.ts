/**
 * A manifest-style plugin running in the host's own process.
 *
 * The subprocess path evaluates a plugin entry under the stdio runtime and
 * talks to it through `PluginHost` over a pipe. This module is the same
 * conversation with the pipe removed: the entry is evaluated with a `serve`
 * built by `makeServe` over an in-memory {@link ServeIO}, and
 * {@link LocalPluginHost} answers the host side of it — same verbs, same
 * capability refusals, same error text, so a component definition built by
 * `remote.ts` cannot tell which transport it is on.
 *
 * Every message still crosses a JSON round-trip, so what a pipe would do to a
 * payload — dropped `undefined`s, a throw on a cycle — happens here too.
 * What is deliberately different from `PluginHost`:
 *
 * - **No timeouts.** A subprocess deadline protects the host from a hung
 *   process it cannot see into; in-process, a hung promise is the host's own
 *   code, and a timer would only turn a debuggable hang into a misleading
 *   error. (Corollary: a handler result that fails to serialize drops the
 *   response and leaves the call waiting, where the subprocess host would
 *   time out.)
 * - **No kill.** Cancel is sent and the handler's signal aborts, but there is
 *   no process to SIGKILL when a plugin ignores it.
 * - **Full trust by default.** The caller already runs the plugin's code in
 *   its own process, so the default grant is every capability; reverse calls
 *   with no per-call wiring fall back to the {@link LocalPluginServices}
 *   handlers instead of being refused, and default to dropping reports.
 */
import { PluginError } from '../errors.js';
import { messageOf } from '../errors.js';
import { isObject, noop } from '../internal/util.js';
import { EVENT_CONTRACT_VERSION } from '../runner/events.js';
import type { CallOptions, PluginCaller } from './host.js';
import type { PluginManifest } from './manifest.js';
import {
  isLogLevel,
  isPartial,
  isPluginMethod,
  isRequest,
  LOG_LEVELS,
  PLUGIN_METHODS,
  PROTOCOL_VERSION,
  readModelRequest,
  spokenProtocol,
  type EmitEventParams,
  type HostMethod,
  type HostMethods,
  type LogParams,
  type PluginMethod,
  type RpcMessage,
  type RpcPartial,
  type RpcRequest,
  type RpcResponse,
  type RunToolParams,
} from './protocol.js';
import {
  admittedVerdicts,
  buildPlugin,
  checkGrant,
  type ShippedResolvers,
} from './remote.js';
import { makeServe, type ServeFn, type ServeIO } from './serve-impl.js';
import type { ModelCaller, ToolRunner } from './services.js';
import type { HeddlePlugin, PluginReporter } from './types.js';

/**
 * What the host offers a plugin that runs in its process.
 *
 * Each one is the fallback for a reverse call that names no per-call wiring
 * of its own — the equivalents of what `CallOptions` carries per call on the
 * subprocess path. All optional: events and logs are dropped by default, and
 * a `runTool`/`callModel` with nothing behind it is refused with the same
 * message `PluginHost` uses.
 */
export interface LocalPluginServices {
  runTool?: (
    call: string,
    name: string,
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  callModel?: (
    call: string,
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  onEvent?: (name: string, data: unknown) => void;
  onLog?: (level: string, message: string) => void;
  /** What the host grants. Defaults to everything: the code already runs here. */
  capabilities?: PluginMethod[];
}

export interface LocalPlugin {
  plugin: HeddlePlugin;
  host: PluginCaller;
}

/**
 * Serve a validated manifest's plugin in-process.
 *
 * `register` is handed the `serve` function and is expected to evaluate the
 * plugin's entry source with it injected — `new Function('serve', source)`
 * for a single-file, import-free entry, or `linkEntry`/`evaluateLinked`
 * (`plugin/esm-link.ts`) for one that imports its own sibling files — so
 * that the entry's own `serve(handlers, …)` call lands here instead of on
 * stdio.
 */
export function servePlugin(
  manifest: PluginManifest,
  register: (serve: ServeFn) => void,
  services: LocalPluginServices = {},
): HeddlePlugin {
  return localPlugin(manifest, register, services).plugin;
}

/** {@link servePlugin}, for a caller that also needs the host to talk through. */
export function localPlugin(
  manifest: PluginManifest,
  register: (serve: ServeFn) => void,
  services: LocalPluginServices = {},
): LocalPlugin {
  checkGrant(manifest, services.capabilities ?? [...PLUGIN_METHODS], {});

  const host = new LocalPluginHost(manifest, services);
  register(makeServe(host.io, PROTOCOL_VERSION));

  const plugin = buildPlugin(
    manifest,
    () => host,
    refusingResolvers(manifest),
  );
  return { plugin, host };
}

/**
 * The two fs-touching branches of `buildPlugin`, refused.
 *
 * An executable tool needs a process and a disk; shipped files need a
 * directory to copy from. Neither exists where this host runs (the point of
 * it is JavaScriptCore on a phone), and `checkPortability` marks bundles
 * carrying either as non-portable before they get here — so these throws are
 * the backstop, not the UX.
 */
function refusingResolvers(manifest: PluginManifest): ShippedResolvers {
  return {
    executableTool(tool) {
      throw new PluginError(
        `plugin "${manifest.name}": tool "${tool.name}" is an executable and ` +
          `cannot run in-process. A tool with a "path" is a program heddle ` +
          `spawns, and this host has no process to spawn it in — run the ` +
          `plugin on a heddle with a disk, or serve the tool from a component ` +
          `("componentType") instead.`,
      );
    },
    files() {
      if (manifest.files.length === 0) return [];
      throw new PluginError(
        `plugin "${manifest.name}" declares "files", which cannot be served ` +
          `in-process. Shipped files are copied from the plugin's own ` +
          `directory into every workspace, and this host has neither — run ` +
          `the plugin on a heddle with a disk.`,
      );
    },
  };
}

interface LocalPending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  release: () => void;
  onPartial?: (partial: unknown) => void;
  reporter?: PluginReporter;
  toolRunner?: ToolRunner;
  modelCaller?: ModelCaller;
  lifecycle?: true;
}

type Respond = (response: Omit<RpcResponse, 'id'>) => void;

/**
 * `PluginHost` with the process removed.
 *
 * Mirrors the observable behavior of the subprocess host wherever both can
 * reach it: lazy init on the first call, per-call routing of reverse
 * messages, abort → reject-and-cancel, the same refusal texts. The refusal
 * strings below are copied from `host.ts` (where they are private) — keep
 * the two in step, the conformance test in `__tests__/serve-local.test.ts`
 * holds them together.
 */
export class LocalPluginHost implements PluginCaller {
  /** The plugin's side of the wire; hand it to {@link makeServe}. */
  readonly io: ServeIO;

  private readonly pending = new Map<number, LocalPending>();
  private readonly granted: ReadonlySet<PluginMethod>;
  private readonly name: string;
  private nextId = 1;
  private started = false;
  private disposed = false;
  private dead?: Error;
  private laterRunner?: ToolRunner;
  private deliver?: (message: unknown) => void;
  private ended?: () => void;

  constructor(
    private readonly manifest: PluginManifest,
    private readonly services: LocalPluginServices,
  ) {
    this.name = manifest.name;
    this.granted = new Set(manifest.capabilities);
    this.io = {
      send: (message) => this.receive(crossBoundary(message)),
      onMessage: (handler) => {
        this.deliver = handler;
      },
      onEnd: (handler) => {
        this.ended = handler;
      },
      // A subprocess's stderr is quoted in its exit message; an in-process
      // plugin has no exit, so there is nowhere the text would surface.
      stderr: noop,
      exit: noop,
    };
  }

  get confined(): boolean {
    return false;
  }

  setToolRunner(run: ToolRunner): void {
    this.laterRunner ??= run;
  }

  async call<M extends HostMethod>(
    method: M,
    params: HostMethods[M],
    options: CallOptions = {},
  ): Promise<unknown> {
    this.assertCallable(method, options.signal);
    this.start();

    const id = this.nextId++;

    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        this.abandon(
          id,
          new PluginError(
            `plugin "${this.name}" was still in ${method} when the run ended`,
          ),
        );
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, {
        resolve,
        reject,
        release: () => options.signal?.removeEventListener('abort', onAbort),
        onPartial: options.onPartial,
        reporter: options.reporter,
        toolRunner: options.runTool,
        modelCaller: options.callModel,
      });

      this.send({ id, method, params });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.die(new PluginError(`plugin "${this.name}" was disposed`));

    // The same farewell the subprocess gets — a shutdown verb and the end of
    // its input — so `options.shutdown` runs. Its answer lands on an empty
    // pending map and is dropped, which is also what happens on the pipe.
    if (!this.started || !this.deliver) return;
    try {
      this.deliver(
        crossBoundary({ id: this.nextId++, method: 'shutdown', params: {} }),
      );
      this.ended?.();
    } catch {
      // A shutdown hook failing is the plugin's problem, reported nowhere —
      // the subprocess host would at most see it on a stderr nobody reads.
    }
  }

  private assertCallable(
    method: string,
    signal: AbortSignal | undefined,
  ): void {
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

  private start(): void {
    if (this.started) return;
    if (!this.deliver) {
      throw new PluginError(
        `plugin "${this.name}" was loaded in-process but its entry never ` +
          `called serve(handlers). The entry is evaluated with serve ` +
          `injected and must call it at load, the way it would under ` +
          `"node --import" with the stdio runtime.`,
      );
    }
    this.started = true;

    const id = this.nextId++;
    this.pending.set(id, {
      resolve: (result) => this.checkProtocol(result),
      reject: noop,
      release: noop,
      lifecycle: true,
    });

    const seams = admittedVerdicts(this.manifest);
    this.send({
      id,
      method: 'init',
      params: {
        protocol: PROTOCOL_VERSION,
        events: EVENT_CONTRACT_VERSION,
        capabilities: [...this.granted],
        ...(seams ? { seams } : {}),
      },
    });
  }

  private checkProtocol(result: unknown): void {
    const spoken = spokenProtocol(result);
    if (spoken === PROTOCOL_VERSION) return;

    this.die(
      new PluginError(
        `plugin "${this.name}" speaks plugin protocol version ${spoken}, ` +
          `and this heddle speaks ${PROTOCOL_VERSION}.`,
      ),
    );
  }

  private send(message: RpcMessage): void {
    this.deliver?.(crossBoundary(message));
  }

  private receive(raw: unknown): void {
    const message = raw as RpcMessage;

    if (isPartial(message)) {
      this.progress(message);
      return;
    }
    if (isRequest(message)) {
      void this.serve(message);
      return;
    }
    if (!isObject(message)) return;

    this.settle(message as RpcResponse);
  }

  private progress(frame: RpcPartial): void {
    const id = idOf(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return;

    try {
      pending.onPartial?.(frame.partial);
    } catch (err) {
      this.abandon(
        id,
        err instanceof Error ? err : new PluginError(String(err)),
      );
    }
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
    if (this.dead) return;

    const id = this.nextId++;
    this.pending.set(id, {
      resolve: noop,
      reject: noop,
      release: noop,
      lifecycle: true,
    });
    this.send({ id, method: 'cancel', params: { call: abandoned } });
  }

  private async serve(request: RpcRequest): Promise<void> {
    const respond: Respond = (response) =>
      this.send({ id: request.id, ...response });

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
      default:
        request.method satisfies never;
    }
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

    try {
      respond({ result: await runner(params.name, params.input ?? {}) });
    } catch (err) {
      respond(failure(err));
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
      respond(
        refuse(
          `callModel named call ${String(call)}, which is not an execute or apply ` +
            `heddle is waiting on. It has already been answered, timed out, been ` +
            `cancelled, or is a lifecycle frame that nothing runs under.`,
        ),
      );
      return;
    }

    const service = this.services.callModel;
    if (!pending.modelCaller && !service) {
      respond(
        refuse(
          `callModel is granted to this plugin, but call ${String(call)} was made ` +
            `with no model to call. A plugin reaches the model through the executor ` +
            `built for its component, and nothing built one here.`,
        ),
      );
      return;
    }

    try {
      const modelRequest = readModelRequest(request.params);
      const response = pending.modelCaller
        ? await pending.modelCaller(modelRequest)
        : await service!(
            String(call),
            modelRequest as unknown as Record<string, unknown>,
          );
      respond({ result: response });
    } catch (err) {
      respond(failure(err));
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
    const perCall =
      call === undefined ? undefined : this.pending.get(idOf(call))?.toolRunner;
    if (perCall) return perCall;

    const service = this.services.runTool;
    if (service) {
      const owner = call === undefined ? '' : String(call);
      return (name, input) => service(owner, name, input);
    }

    return this.laterRunner;
  }

  private reportingTo(
    verb: 'emitEvent' | 'log',
    request: RpcRequest,
    respond: Respond,
  ): PluginReporter | undefined {
    const call = namedCall(request);
    if (call === undefined) {
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

    // The per-call reporter when the call brought one; the host's services
    // otherwise. Absent handlers drop, which is the in-process default — the
    // code already runs here, so a report refused would protect nobody.
    return (
      pending.reporter ?? {
        emitEvent: (name, data) => this.services.onEvent?.(name, data),
        log: (level, message) => this.services.onLog?.(level, message),
      }
    );
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

    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.release();
      pending.reject(err);
    }
  }
}

/**
 * What the pipe would have done to this message.
 *
 * Serialization semantics are part of the plugin contract — an `undefined`
 * never arrives, a cycle throws at the sender — and an in-process pair that
 * skipped this would let plugins grow dependencies on object identity that
 * break the moment they run out of process.
 */
function crossBoundary<T>(message: T): T {
  return JSON.parse(JSON.stringify(message)) as T;
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
      message: messageOf(err),
    },
  };
}

function ungrantedMessage(method: string): string {
  return (
    `"${method}" is not granted to this plugin. ` +
    `Add it to "capabilities" in the manifest: a plugin gets only what it ` +
    `declares, and whether the host allows it is settled when the plugin ` +
    `loads rather than here.`
  );
}
