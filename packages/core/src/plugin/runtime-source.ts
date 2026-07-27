/**
 * The plugin's side of the protocol, as source text.
 *
 * A string rather than a module, because its consumer is a *different process*
 * that has no way to import anything. A plugin submitted to the playground is
 * written into a temp directory with no `node_modules` beside it, so the only
 * way it can call `serve()` is if `serve()` arrives in the same file.
 *
 * Keeping it as one string is also what keeps it honest: there is a single
 * definition of the protocol's client half, and `remote.test.ts` runs a plugin
 * built from this exact text. A second, typed copy for authors to import would
 * be nicer to write against and would drift.
 *
 * Plugins that are installed rather than submitted can write this to a file and
 * import it; it is exported from the package for that reason.
 *
 * ---
 *
 * What a plugin author writes, once this is prepended:
 *
 * ```js
 * serve({
 *   ShoutNode: {
 *     execute: (input) => ({ output: { text: String(input.text).toUpperCase() } }),
 *   },
 *   Blocklist: {
 *     apply: (messages) =>
 *       /badword/.test(messages.at(-1)?.content ?? '')
 *         ? { action: 'reject', reason: 'blocked' }
 *         : { action: 'pass' },
 *   },
 * });
 * ```
 *
 * `execute` and `apply` receive a `ctx` with `runTool(name, input)` and the
 * component's own spec fields. `runTool` is always there to call and is refused
 * unless the manifest lists it under `capabilities` — the function exists so
 * that a plugin which forgot to declare it gets an error saying exactly that,
 * rather than an undefined it has to work out for itself.
 *
 * `ctx.signal` is an `AbortSignal` that fires when heddle cancels the call or
 * stops the plugin. Cancellation is cooperative, exactly as it is anywhere else
 * in Node: a handler that never reads the signal keeps running, and heddle
 * kills the process shortly after. A handler that does read it lets its process
 * survive to serve the next call.
 *
 * `serve` takes a second argument for the things that are not per-component:
 *
 * ```js
 * serve(handlers, { shutdown: async () => pool.end() });
 * ```
 *
 * `shutdown` runs when heddle asks the plugin to stop, before the process
 * exits. It has about a second — heddle kills what has not exited by then, so
 * this is where a connection closes, not where a backlog drains.
 *
 * The helper answers heddle's `init` with the protocol version it was generated
 * from, so a plugin built against a heddle that has moved on is told so at the
 * handshake instead of discovering it as an unknown verb mid-run.
 *
 * **stdout is the protocol.** A plugin that prints to stdout would corrupt the
 * channel, so `console.log` is redirected to stderr below. That is the single
 * most common way to break a plugin, and quietly fixing it is kinder than the
 * parse error it would otherwise cause — heddle reports that error naming this
 * cause, for the case where a plugin writes to `process.stdout` directly.
 */
import { PROTOCOL_VERSION } from './protocol.js';

export const PLUGIN_RUNTIME_JS = String.raw`
// --- heddle plugin runtime (inlined) ----------------------------------------
// Everything below is supplied by heddle. Your code follows.
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

  const runTool = (name, input) =>
    new Promise((resolve, reject) => {
      const id = 't' + nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method: 'runTool', params: { name, input: input ?? {} } });
    });

  // Every call heddle is still waiting on, so cancel and shutdown have
  // something to act on rather than a promise nobody kept a handle to.
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

  // Answered before the componentType lookup below, which these carry none of.
  const lifecycle = (request) => {
    if (request.method === 'init') {
      send({ id: request.id, result: { protocol: HEDDLE_PROTOCOL_VERSION } });
      return true;
    }
    if (request.method === 'cancel') {
      const target = String((request.params || {}).call);
      const entry = inflight.get(target);
      // Not ours, or already finished. heddle reads an error here as "could not
      // vouch for it" and kills, which is the right answer: there is nothing to
      // abort and nothing to promise about.
      if (!entry) {
        send({ id: request.id, error: { message: 'no call ' + target + ' in flight' } });
        return true;
      }
      // Recorded, not answered. heddle spares the process on the strength of
      // this reply, so it may only go out once the handler has actually
      // stopped — and aborting does not stop anything by itself. Cancellation
      // is cooperative: a handler that never reads ctx.signal runs to
      // completion, and one that never returns never lets this be sent, which
      // is exactly when heddle should be killing the process instead.
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

  const handle = async (request) => {
    if (lifecycle(request)) return;

    const params = request.params || {};
    const handler = handlers[params.componentType];
    if (!handler) {
      send({ id: request.id, error: { message: 'this plugin does not provide "' + params.componentType + '"' } });
      return;
    }
    const key = String(request.id);
    const controller = new AbortController();
    inflight.set(key, { controller, cancelId: undefined });
    try {
      const ctx = {
        runTool,
        node: params.node || params.component || {},
        phase: params.phase,
        signal: controller.signal,
      };
      const result =
        request.method === 'apply'
          ? await handler.apply(params.messages || [], ctx)
          : await handler.execute(params.input || {}, ctx);
      settle(key, request.id, { result });
    } catch (err) {
      settle(key, request.id, {
        error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) },
      });
    }
  };

  // The one place a dispatched call stops being in flight.
  //
  // A cancelled call answers the cancel instead of itself: heddle has already
  // failed the original and would discard an answer to it, and the cancel is
  // what it is actually waiting on before deciding whether to kill this
  // process. Sending both would be noise on a channel where noise is the
  // failure mode; sending neither is what makes heddle kill.
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

  // heddle closes stdin to end the run, and does it right after "shutdown" —
  // so this races the verb, and stop() is written to let either win.
  process.stdin.on('end', () => void stop());
}
// --- end heddle plugin runtime ----------------------------------------------
`;

/** Prepend the runtime to a plugin's source, producing a runnable module. */
export function withRuntime(source: string): string {
  return `${PLUGIN_RUNTIME_JS}\n${source}\n`;
}
