/**
 * The one implementation of a plugin's `serve(handlers, options)`.
 *
 * Two hosts run it. A subprocess plugin gets it embedded in the data-URL
 * runtime (`runtime-source.ts` stringifies {@link makeServe} with
 * `Function.prototype.toString` and wires it to stdio), and an in-process
 * plugin gets it called directly with an in-memory pair (`serve-local.ts`).
 * One body, so the dispatch rules — capability grants, event-name validation,
 * the `contextFor` shape, cancel/inflight bookkeeping — cannot drift between
 * the two transports.
 *
 * BECAUSE IT IS STRINGIFIED, the function must stay fully self-contained:
 * no imports, no references to anything in this module's scope, no TS syntax
 * in the body that does not erase to plain ES2022 (type annotations are fine;
 * enums, namespaces and parameter properties are not). The subprocess plugin
 * tests spawn real node children through the stringified copy and are the
 * check that this property holds.
 */

/**
 * The transport seam `makeServe` is parameterized over.
 *
 * Messages are objects on both sides of this interface; framing (NDJSON
 * lines on a pipe, or nothing at all in-process) is the shell's business.
 */
export interface ServeIO {
  /** Deliver a message from the plugin to the host. */
  send(message: unknown): void;
  /** Register the handler for messages arriving from the host. */
  onMessage(handler: (message: unknown) => void): void;
  /** Register the handler for the host's side going away. */
  onEnd(handler: () => void): void;
  /** Write diagnostic text (already newline-terminated) somewhere the protocol is not. */
  stderr(text: string): void;
  /** The plugin was told to stop and has finished shutting down. */
  exit(): void;
  /**
   * Whether `console.log`/`info`/`debug` should be rerouted to {@link stderr}.
   *
   * True on stdio, where stdout carries the protocol and a stray
   * `console.log` would corrupt it. Left unset in-process, where the console
   * belongs to the host application and is not this plugin's to redirect.
   */
  redirectConsole?: boolean;
}

/** What a plugin passes as `serve`'s second argument. */
export interface ServeOptions {
  tools?: Record<
    string,
    (
      input: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => unknown
  >;
  listTools?: () => unknown;
  shutdown?: () => unknown;
}

/** The `serve` function a plugin entry calls. */
export type ServeFn = (
  handlers: Record<string, unknown>,
  options?: ServeOptions,
) => void;

/**
 * Build a `serve` bound to one transport.
 *
 * `protocolVersion` arrives as a parameter for the same reason `io` does:
 * the body may reference nothing outside itself.
 */
export function makeServe(io: ServeIO, protocolVersion: number): ServeFn {
  return function serve(handlers: any, options?: any): void {
    const toStderr = (...args: any[]) => {
      io.stderr(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
    };
    if (io.redirectConsole) {
      console.log = toStderr;
      console.info = toStderr;
      console.debug = toStderr;
    }

    const send = (message: any) => io.send(message);

    const pending = new Map<string, { resolve: (value: any) => void; reject: (err: any) => void }>();
    let nextId = 0;

    const runTool = (call: any, name: any, input: any) =>
      new Promise((resolve, reject) => {
        const id = 't' + nextId++;
        pending.set(id, { resolve, reject });
        send({ id, method: 'runTool', params: { call, name, input: input ?? {} } });
      });

    const callModel = (call: any, request: any) =>
      new Promise((resolve, reject) => {
        const id = 'm' + nextId++;
        pending.set(id, { resolve, reject });
        send({ id, method: 'callModel', params: Object.assign({ call: call }, request || {}) });
      });

    let granted = new Set<string>();
    let seamAdmits: any = {};

    const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

    // The verb a store answers, and the handler name it answers it with. Named
    // for the store's own method rather than the verb, so writing one reads like
    // implementing an interface rather than like serving a protocol.
    const SESSION_METHODS: Record<string, string> = {
      sessionCreate: 'create',
      sessionRead: 'read',
      sessionAppend: 'append',
      sessionCheckpointRead: 'readCheckpoint',
      sessionCheckpointWrite: 'writeCheckpoint',
      sessionList: 'list',
      sessionDelete: 'delete',
    };
    const STORE_HANDLERS = Object.keys(SESSION_METHODS).map((k) => SESSION_METHODS[k]);

    const needs = (verb: string) => {
      if (granted.has(verb)) return;
      throw new Error(
        verb + ' is not granted to this plugin. Add it to "capabilities" in the ' +
          'manifest: a plugin gets only what it declares.',
      );
    };

    const report = (call: any, method: string, params: any) => {
      const id = 'r' + nextId++;
      pending.set(id, {
        resolve: () => {},
        reject: (err: any) => toStderr('heddle refused ' + method + ': ' + err.message),
      });
      send({ id, method, params: Object.assign({ call }, params) });
    };

    const emitEvent = (call: any, name: any, data: any) => {
      needs('emitEvent');
      if (typeof name !== 'string' || !EVENT_NAME.test(name)) {
        throw new Error(
          JSON.stringify(name) + ' is not a usable event name. heddle publishes this ' +
            'event as "plugin:<componentType>:<name>", so the name is its last segment ' +
            'and has to match ' + EVENT_NAME.source + ' — letters, digits and ' +
            'underscores, starting with a letter or underscore. Try "progress".',
        );
      }
      if (data !== undefined) {
        try {
          JSON.stringify(data);
        } catch (err: any) {
          throw new Error(
            '"' + name + '" was emitted with data that is not JSON: ' +
              String((err && err.message) || err) + '. An event payload is written ' +
              'straight into the client stream, so it has to be plain values — no ' +
              'cycles, no BigInt, no class instances that stringify to nothing.',
          );
        }
      }
      report(call, 'emitEvent', { name, data });
    };

    const log = (call: any, level: any, message: any) => {
      needs('log');
      if (LOG_LEVELS.indexOf(level) === -1) {
        throw new Error(
          'log level ' + JSON.stringify(level) + ' is not one of: ' +
            LOG_LEVELS.join(', ') + '.',
        );
      }
      report(call, 'log', { level, message: String(message) });
    };

    const workspaceOf = (params: any) => {
      if (typeof params.workspace === 'string') return params.workspace;
      if (params.workspaceUnavailable === 'confined') {
        throw new Error(
          'getWorkspace has nothing to return: this plugin runs inside a sandbox of ' +
            'its own, and the directory its node shares with the tools it runs is ' +
            'outside that sandbox — a path this process could not open. Pass what the ' +
            'tool needs in runTool\'s input, or ask the operator to run without --safe.',
        );
      }
      throw new Error(
        'getWorkspace is only available while a node is executing. A transform owns ' +
          'no tool scope, so there is no directory its tool calls would share and ' +
          'heddle sends it none.',
      );
    };

    const inflight = new Map<string, { controller: AbortController; cancelId: any }>();
    let stopping = false;

    const stop = async () => {
      if (stopping) return;
      stopping = true;
      for (const entry of inflight.values()) entry.controller.abort();
      inflight.clear();
      try {
        if (options && typeof options.shutdown === 'function') await options.shutdown();
      } catch (err: any) {
        toStderr('plugin shutdown failed: ' + String((err && err.message) || err));
      }
      io.exit();
    };

    const lifecycle = (request: any) => {
      if (request.method === 'init') {
        granted = new Set((request.params || {}).capabilities || []);
        seamAdmits = (request.params || {}).seams || {};
        send({ id: request.id, result: { protocol: protocolVersion } });
        return true;
      }
      if (request.method === 'cancel') {
        const target = String((request.params || {}).call);
        const entry = inflight.get(target);
        if (!entry) {
          send({ id: request.id, error: { message: 'no call ' + target + ' in flight' } });
          return true;
        }
        entry.cancelId = request.id;
        entry.controller.abort();
        return true;
      }
      if (request.method === 'shutdown') {
        send({ id: request.id, result: {} });
        void stop();
        return true;
      }
      return false;
    };

    const serveTool = async (request: any, params: any) => {
      const impl = (options && options.tools && options.tools[params.tool]) || undefined;
      if (!impl) {
        send({ id: request.id, error: { message:
          'this plugin declares the tool "' + params.tool + '" in its manifest but ' +
          'serves no handler for it. Write serve(handlers, { tools: { ' +
          params.tool + ': async (input, ctx) => ({ output: { … } }) } }).' } });
        return;
      }
      const key = String(request.id);
      const controller = new AbortController();
      inflight.set(key, { controller, cancelId: undefined });
      try {
        const ctx = { signal: controller.signal, tool: params.tool };
        const result = await impl(params.input || {}, ctx);
        settle(key, request.id, { result: result || {} });
      } catch (err: any) {
        settle(key, request.id, {
          error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) },
        });
      }
    };

    const contextFor = (request: any, params: any, controller: AbortController) => ({
      partial: (chunk: any) => {
        if (request.method !== 'chat' || !params.stream) {
          throw new Error(
            'ctx.partial is only available to a provider serving a streamed chat. ' +
              'To report progress from a node or a transform, use ctx.emitEvent — ' +
              'a partial goes to the one call awaiting it, an event goes to the run.',
          );
        }
        send({ id: request.id, partial: chunk });
      },
      runTool: (name: any, input: any) => runTool(request.id, name, input),
      callModel: (modelRequest: any) => callModel(request.id, modelRequest),
      node: params.node || params.component || {},
      component: params.component || params.node || params.config || {},
      phase: params.phase,
      runId: params.runId,
      stream: params.stream === true,
      seam: params.seam,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      answered: params.answered,
      admits: (seamAdmits[params.seam] || []).slice(),
      signal: controller.signal,
      emitEvent: (name: any, data: any) => emitEvent(request.id, name, data),
      log: (level: any, message: any) => log(request.id, level, message),
      getWorkspace: () => workspaceOf(params),
    });

    const missingHandler = (request: any, message: string) => {
      send({ id: request.id, error: { message } });
      inflight.delete(String(request.id));
    };

    const dispatch = async (request: any, params: any, handler: any, ctx: any) => {
      if (request.method === 'apply') {
        return await handler.apply(params.messages || [], ctx);
      }
      if (request.method === 'chat') {
        if (!handler.chat) {
          missingHandler(
            request,
            '"' + params.componentType + '" is declared as a provider in this ' +
              "plugin's manifest but serves no chat handler. Write serve({ " +
              params.componentType + ': { chat(request, ctx) { … } } }).',
          );
          return undefined;
        }
        return await handler.chat(params.request || {}, ctx);
      }
      if (request.method === 'before') {
        const hook = handler[params.seam] && handler[params.seam].before;
        if (!hook) {
          missingHandler(
            request,
            '"' + params.componentType + '" hooks the "before" half of "' +
              params.seam + '" in its manifest but provides no handler for it. ' +
              'Write serve({ ' + params.componentType + ': { ' + params.seam +
              ': { before(input, ctx) { … } } } }).',
          );
          return undefined;
        }
        return await hook(
          { subject: params.subject || {}, input: params.input || {} },
          ctx,
        );
      }
      if (request.method === 'after') {
        const hook = handler[params.seam] && handler[params.seam].after;
        if (!hook) {
          missingHandler(
            request,
            '"' + params.componentType + '" declares the "' + params.seam +
              '" seam in its manifest but provides no handler for it. Write ' +
              'serve({ ' + params.componentType + ': { ' + params.seam +
              ': { after(input, ctx) { … } } } }).',
          );
          return undefined;
        }
        return await hook(
          { subject: params.subject || {}, outcome: params.outcome || {} },
          ctx,
        );
      }
      if (request.method === 'encode' || request.method === 'finishEncode') {
        const encoding = request.method === 'encode';
        const hook = encoding ? handler.encode : handler.finish;
        if (!hook) {
          missingHandler(
            request,
            '"' + params.componentType + '" is declared as an encoder in this ' +
              "plugin's manifest but serves no " + (encoding ? 'encode' : 'finish') +
              ' handler. Write serve({ ' + params.componentType +
              ': { encode(event, ctx) { … }, finish(ctx) { … } } }).',
          );
          return undefined;
        }
        return encoding ? await hook(params.event || {}, ctx) : await hook(ctx);
      }
      if (SESSION_METHODS[request.method]) {
        const name = SESSION_METHODS[request.method];
        const hook = handler[name];
        if (!hook) {
          missingHandler(
            request,
            '"' + params.componentType + '" is declared as a store in this ' +
              "plugin's manifest but serves no " + name + ' handler. A store ' +
              'answers all of: ' + STORE_HANDLERS.join(', ') + '. Write ' +
              'serve({ ' + params.componentType + ': { ' + name +
              '(params, ctx) { … } } }).',
          );
          return undefined;
        }
        return await hook(params, ctx);
      }
      return await handler.execute(params.input || {}, ctx);
    };

    const handle = async (request: any) => {
      if (lifecycle(request)) return;

      const params = request.params || {};

      // Addressed to the plugin rather than to one of its components, so it is
      // answered before the componentType lookup below — which this carries none of.
      if (request.method === 'listTools') {
        const list = options && options.listTools;
        if (typeof list !== 'function') {
          send({ id: request.id, error: { message:
            'this plugin declares "discoverTools" in its manifest but serves no ' +
            'listTools handler. Write serve(handlers, { listTools: async () => ' +
            '({ tools: [ … ] }) }).' } });
          return;
        }
        try {
          send({ id: request.id, result: (await list()) || { tools: [] } });
        } catch (err: any) {
          send({ id: request.id, error: {
            name: (err && err.name) || 'Error',
            message: String((err && err.message) || err) } });
        }
        return;
      }

      if (request.method === 'callTool') {
        await serveTool(request, params);
        return;
      }

      const handler = handlers[params.componentType];
      if (!handler) {
        send({ id: request.id, error: { message: 'this plugin does not provide "' + params.componentType + '"' } });
        return;
      }

      const key = String(request.id);
      const controller = new AbortController();
      inflight.set(key, { controller, cancelId: undefined });
      try {
        const ctx = contextFor(request, params, controller);
        const result = await dispatch(request, params, handler, ctx);
        settle(key, request.id, { result });
      } catch (err: any) {
        settle(key, request.id, {
          error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) },
        });
      }
    };

    const settle = (key: string, requestId: any, payload: any) => {
      const entry = inflight.get(key);
      if (!entry) return;
      inflight.delete(key);
      if (entry.cancelId !== undefined) send({ id: entry.cancelId, result: {} });
      else send(Object.assign({ id: requestId }, payload));
    };

    io.onMessage((message: any) => {
      if (typeof message.method === 'string') {
        void handle(message);
        return;
      }
      const waiting = pending.get(String(message.id));
      if (waiting) {
        pending.delete(String(message.id));
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result || {});
      }
    });

    io.onEnd(() => void stop());
  };
}
