import { PROTOCOL_VERSION } from './protocol.js';

export const PLUGIN_RUNTIME_JS = String.raw`
const HEDDLE_PROTOCOL_VERSION = ${PROTOCOL_VERSION};

function serve(handlers, options) {
  const toStderr = (...args) => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;

  const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');

  const pending = new Map();
  let nextId = 0;

  const runTool = (call, name, input) =>
    new Promise((resolve, reject) => {
      const id = 't' + nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method: 'runTool', params: { call, name, input: input ?? {} } });
    });

  const callModel = (call, request) =>
    new Promise((resolve, reject) => {
      const id = 'm' + nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method: 'callModel', params: Object.assign({ call: call }, request || {}) });
    });

  let granted = new Set();
  let seamAdmits = {};

  const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

  const needs = (verb) => {
    if (granted.has(verb)) return;
    throw new Error(
      verb + ' is not granted to this plugin. Add it to "capabilities" in the ' +
        'manifest: a plugin gets only what it declares.',
    );
  };

  const report = (call, method, params) => {
    const id = 'r' + nextId++;
    pending.set(id, {
      resolve: () => {},
      reject: (err) => toStderr('heddle refused ' + method + ': ' + err.message),
    });
    send({ id, method, params: Object.assign({ call }, params) });
  };

  const emitEvent = (call, name, data) => {
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
      } catch (err) {
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

  const log = (call, level, message) => {
    needs('log');
    if (LOG_LEVELS.indexOf(level) === -1) {
      throw new Error(
        'log level ' + JSON.stringify(level) + ' is not one of: ' +
          LOG_LEVELS.join(', ') + '.',
      );
    }
    report(call, 'log', { level, message: String(message) });
  };

  const workspaceOf = (params) => {
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

  const inflight = new Map();
  let stopping = false;

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    for (const entry of inflight.values()) entry.controller.abort();
    inflight.clear();
    try {
      if (options && typeof options.shutdown === 'function') await options.shutdown();
    } catch (err) {
      toStderr('plugin shutdown failed: ' + String((err && err.message) || err));
    }
    process.exit(0);
  };

  const lifecycle = (request) => {
    if (request.method === 'init') {
      granted = new Set((request.params || {}).capabilities || []);
      seamAdmits = (request.params || {}).seams || {};
      send({ id: request.id, result: { protocol: HEDDLE_PROTOCOL_VERSION } });
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

  const serveTool = async (request, params) => {
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
    } catch (err) {
      settle(key, request.id, {
        error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) },
      });
    }
  };

  const contextFor = (request, params, controller) => ({
    partial: (chunk) => {
      if (request.method !== 'chat' || !params.stream) {
        throw new Error(
          'ctx.partial is only available to a provider serving a streamed chat. ' +
            'To report progress from a node or a transform, use ctx.emitEvent — ' +
            'a partial goes to the one call awaiting it, an event goes to the run.',
        );
      }
      send({ id: request.id, partial: chunk });
    },
    runTool: (name, input) => runTool(request.id, name, input),
    callModel: (modelRequest) => callModel(request.id, modelRequest),
    node: params.node || params.component || {},
    component: params.component || params.node || params.config || {},
    phase: params.phase,
    runId: params.runId,
    stream: params.stream === true,
    seam: params.seam,
    attempt: params.attempt,
    maxAttempts: params.maxAttempts,
    admits: (seamAdmits[params.seam] || []).slice(),
    signal: controller.signal,
    emitEvent: (name, data) => emitEvent(request.id, name, data),
    log: (level, message) => log(request.id, level, message),
    getWorkspace: () => workspaceOf(params),
  });

  const missingHandler = (request, message) => {
    send({ id: request.id, error: { message } });
    inflight.delete(String(request.id));
  };

  const dispatch = async (request, params, handler, ctx) => {
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
    return await handler.execute(params.input || {}, ctx);
  };

  const handle = async (request) => {
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
      } catch (err) {
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
    } catch (err) {
      settle(key, request.id, {
        error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) },
      });
    }
  };

  const settle = (key, requestId, payload) => {
    const entry = inflight.get(key);
    if (!entry) return;
    inflight.delete(key);
    if (entry.cancelId !== undefined) send({ id: entry.cancelId, result: {} });
    else send(Object.assign({ id: requestId }, payload));
  };

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write('plugin received a line that is not JSON: ' + line.slice(0, 200) + '\n');
        continue;
      }
      if (typeof message.method === 'string') {
        void handle(message);
        continue;
      }
      const waiting = pending.get(String(message.id));
      if (waiting) {
        pending.delete(String(message.id));
        if (message.error) waiting.reject(new Error(message.error.message));
        else waiting.resolve(message.result || {});
      }
    }
  });

  process.stdin.on('end', () => void stop());
}
`;

export function withRuntime(source: string): string {
  return `${PLUGIN_RUNTIME_JS}\n${source}\n`;
}
