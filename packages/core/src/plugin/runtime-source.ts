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
 * `execute` and `apply` receive a `ctx` with the component's own spec fields and
 * five things to call:
 *
 * ```js
 * await ctx.runTool('grep', { pattern: 'TODO' });    // run a flow tool
 * await ctx.callModel({ messages });                 // ask the model
 * ctx.emitEvent('progress', { done: 3, total: 10 }); // tell the run's watchers
 * ctx.log('warn', 'retrying after a 429');           // say something for a person
 * const dir = ctx.getWorkspace();                    // a directory tools can see
 * ```
 *
 * Every one of these is a capability the manifest has to list under
 * `capabilities`, except `getWorkspace`, which is not a call into heddle at all
 * — the path arrives with the request. They are always there to call and fail
 * when they were not declared, so a plugin that forgot gets an error saying
 * exactly that rather than an `undefined` to work out for itself.
 *
 * `ctx.emitEvent(name, data)` publishes an event on the run's stream, where
 * every client watching the run sees it. **You supply only `name`**: heddle
 * publishes it as `plugin:<componentType>:<name>`, so an event of yours can
 * never be read as one of heddle's own. `name` has to be an identifier
 * (`[A-Za-z_][A-Za-z0-9_]*`) and `data` has to be plain JSON; both are checked
 * here, in your process, so a mistake throws at the call that made it.
 *
 * `ctx.callModel({ messages, responseFormat, temperature, maxTokens, topP })`
 * asks a model and returns `{ content, tool_calls?, finish_reason }` — the same
 * answer an agent node gets. **You do not choose the model.** It comes from the
 * `llm_config` on your own component in the spec, exactly as an agent's does:
 *
 * ```yaml
 * - component_type: LlmJudge
 *   name: judge
 *   rubric: "Is the answer supported by the sources?"
 *   llm_config:
 *     component_type: OpenAiConfig
 *     model_id: gpt-4o-mini
 * ```
 *
 * So you ship no SDK and hold no credential — your process has an empty
 * environment and could not use one — and whoever runs your plugin can read
 * their own spec and see every model it will reach. A component with no
 * `llm_config` gets an error naming the field; heddle never quietly borrows
 * whatever endpoint the operator configured for something else.
 *
 * `messages` is `[{ role, content }]` with roles `system`, `user`, `assistant`
 * or `tool`. `responseFormat: 'json'` asks for a JSON object back. The three
 * generation settings override whatever the spec's
 * `default_generation_parameters` set, and anything you leave out keeps the
 * spec's value.
 *
 * The answer arrives whole; there is no streamed form. heddle cannot tell your
 * model call from your scratch work — a judge asks for a score and returns a
 * number — so streaming it would publish your reasoning as the run's answer.
 * Say what you want said with `emitEvent`. And the call does not spend your
 * deadline: heddle stops your per-call clock for as long as it is the one
 * making you wait.
 *
 * `ctx.log(level, message)` — `debug`, `info`, `warn` or `error` — is for a
 * person rather than a program. It is not the same as writing to stderr: heddle
 * keeps only the last few kilobytes of that and shows it only when your process
 * *fails*, so a plugin that works has no way to say anything. A log line is an
 * event, so it survives success and arrives in order with everything else.
 *
 * `ctx.getWorkspace()` returns a directory this execution shares with the tools
 * it runs, so a file you write can be named to `runTool` by path. It is the
 * only way to hand a tool something large — `runTool` input is JSON on its way
 * to a subprocess's stdin. heddle destroys it when the node returns. It is
 * available to `execute` and not to `apply`: a transform owns no tool scope, so
 * there is no directory its tool calls would agree on.
 *
 * It also throws when the operator runs heddle with `--safe`, which confines
 * your process to a sandbox of its own. The node's tools are confined to a
 * different one, so there is no directory both sides can open and heddle sends
 * none rather than a path that would fail at your first write. Under `--safe` a
 * plugin node hands a tool its input through `runTool` and nothing else.
 *
 * **There is one way to report progress and this is it.** The protocol also has
 * a `{ id, partial }` frame, and it is not a second one: a partial is a piece of
 * *one call's answer*, delivered only to whatever inside heddle is awaiting that
 * call — and nothing awaits a plugin's yet, so this helper deliberately gives
 * you no way to send one. An event is a report *about the run*, and it reaches
 * the client. Neither costs you your deadline: heddle's per-call timeout is a
 * silence budget, and anything you report resets it, so a plugin that works for
 * ten minutes and says so throughout is not killed for taking ten minutes.
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

  // Bound to the call it was made inside, like a report. Not for attribution
  // here but for scope: heddle runs the tool in the tool scope it opened for
  // that call, which is the one whose directory getWorkspace() names. Without
  // the id the tool lands in a throwaway sandbox session and cannot see the
  // file this plugin just wrote for it.
  const runTool = (call, name, input) =>
    new Promise((resolve, reject) => {
      const id = 't' + nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method: 'runTool', params: { call, name, input: input ?? {} } });
    });

  // Bound to the call for a third reason on top of scope and the clock: which
  // model answers comes from the component this call is running, so the id is
  // how heddle knows which llm_config to use. There is no needs() check here
  // for the same reason runTool has none — this promise is awaited, so heddle's
  // own refusal arrives at the call that made it.
  const callModel = (call, request) =>
    new Promise((resolve, reject) => {
      const id = 'm' + nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method: 'callModel', params: Object.assign({ call: call }, request || {}) });
    });

  // What heddle's init said this plugin was granted.
  let granted = new Set();

  // heddle's own rules, restated in the plugin's process because this is the
  // only place a check can throw at the call that broke it. emitEvent and log
  // return nothing, so heddle's refusal comes back as a frame nobody is
  // awaiting — checked only there, a plugin that misspelt an event name or
  // forgot to declare the capability would report into silence.
  const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

  const needs = (verb) => {
    if (granted.has(verb)) return;
    throw new Error(
      verb + ' is not granted to this plugin. Add it to "capabilities" in the ' +
        'manifest: a plugin gets only what it declares.',
    );
  };

  // Sent, not awaited. In heddle's process these two return nothing, and they
  // return nothing here for the same reason: the same plugin logic has to be
  // writable for both. What is left for heddle to refuse a well-formed report
  // for is heddle's own wiring, so that goes to stderr rather than to a caller
  // who is not listening for it.
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

  // Two different people's problems arrive here as the same missing field, so
  // heddle marks which. Blaming transforms for both would send a node author
  // whose operator runs --safe to change something that is already correct.
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
      // The settled grant, which is what the checks above test against. A
      // plugin that is never greeted has been granted nothing, and that is the
      // right answer rather than a special case: no handshake, no permission.
      granted = new Set((request.params || {}).capabilities || []);
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
        runTool: (name, input) => runTool(request.id, name, input),
        callModel: (modelRequest) => callModel(request.id, modelRequest),
        node: params.node || params.component || {},
        phase: params.phase,
        signal: controller.signal,
        // Bound to this request's id, so heddle knows which node a report
        // belongs to and can keep that call's clock running. A plugin never
        // supplies it, which is what makes the attribution heddle's.
        emitEvent: (name, data) => emitEvent(request.id, name, data),
        log: (level, message) => log(request.id, level, message),
        getWorkspace: () => workspaceOf(params),
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
