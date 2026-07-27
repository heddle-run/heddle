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
 * **stdout is the protocol.** A plugin that prints to stdout would corrupt the
 * channel, so `console.log` is redirected to stderr below. That is the single
 * most common way to break a plugin, and quietly fixing it is kinder than the
 * parse error it would otherwise cause — heddle reports that error naming this
 * cause, for the case where a plugin writes to `process.stdout` directly.
 */
export const PLUGIN_RUNTIME_JS = String.raw`
// --- heddle plugin runtime (inlined) ----------------------------------------
// Everything below is supplied by heddle. Your code follows.
function serve(handlers) {
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

  const handle = async (request) => {
    const params = request.params || {};
    const handler = handlers[params.componentType];
    if (!handler) {
      send({ id: request.id, error: { message: 'this plugin does not provide "' + params.componentType + '"' } });
      return;
    }
    try {
      const ctx = { runTool, node: params.node || params.component || {}, phase: params.phase };
      const result =
        request.method === 'apply'
          ? await handler.apply(params.messages || [], ctx)
          : await handler.execute(params.input || {}, ctx);
      send({ id: request.id, result });
    } catch (err) {
      send({
        id: request.id,
        error: { name: (err && err.name) || 'Error', message: String((err && err.message) || err) },
      });
    }
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

  // heddle closes stdin to end the run.
  process.stdin.on('end', () => process.exit(0));
}
// --- end heddle plugin runtime ----------------------------------------------
`;

/** Prepend the runtime to a plugin's source, producing a runnable module. */
export function withRuntime(source: string): string {
  return `${PLUGIN_RUNTIME_JS}\n${source}\n`;
}
