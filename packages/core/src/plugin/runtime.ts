/**
 * The plugin's side of the protocol.
 *
 * A plugin author should not have to implement JSON-Lines framing, id matching
 * and reverse calls to write a node. `serve()` does that, leaving them with
 * the same shape the in-process API asks for: a function from input to
 * `{ output }`.
 *
 * ```js
 * import { serve } from '@heddle/core/plugin-runtime';
 *
 * serve({
 *   ShoutNode: {
 *     execute: (input) => ({ output: { text: String(input.text).toUpperCase() } }),
 *   },
 *   Blocklist: {
 *     apply: (messages, ctx) =>
 *       /badword/.test(messages.at(-1)?.content ?? '')
 *         ? { action: 'reject', reason: 'blocked' }
 *         : { action: 'pass' },
 *   },
 * });
 * ```
 *
 * This module is deliberately dependency-free and self-contained: it has to
 * work in a plugin that was written into a temp directory by a request and has
 * no node_modules to resolve.
 *
 * **stdout is the protocol.** A plugin that prints to stdout corrupts the
 * channel, so `serve()` redirects `console.log` to stderr on the way in. That
 * is the single most common way to break a plugin, and silently fixing it is
 * kinder than the parse error it would otherwise produce.
 */

export interface ServeContext {
  /** Run one of the flow's tools, by name. A reverse call into heddle. */
  runTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** The component's own spec fields. */
  node: Record<string, unknown>;
  phase?: 'pre' | 'post';
}

export interface NodeHandler {
  execute(
    input: Record<string, unknown>,
    ctx: ServeContext,
  ): unknown | Promise<unknown>;
}

export interface TransformHandler {
  apply(messages: unknown[], ctx: ServeContext): unknown | Promise<unknown>;
}

export type Handlers = Record<string, NodeHandler | TransformHandler>;

interface Message {
  id: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { name?: string; message: string };
}

/**
 * Start serving. Reads requests on stdin until it closes, then exits.
 *
 * Returns nothing and never resolves in normal use — the process ends when
 * heddle disposes it.
 */
export function serve(handlers: Handlers): void {
  // Anything the plugin logs must not land on the protocol channel.
  const log = (...args: unknown[]): void => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  console.log = log;
  console.info = log;
  console.debug = log;

  const pending = new Map<string, (message: Message) => void>();
  let nextId = 0;

  const send = (message: Message): void => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };

  const runTool = (
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = `t${nextId++}`;
      pending.set(id, (message) => {
        if (message.error) {
          reject(new Error(message.error.message));
          return;
        }
        resolve((message.result ?? {}) as Record<string, unknown>);
      });
      send({ id, method: 'runTool', params: { name, input } });
    });

  const handle = async (request: Message): Promise<void> => {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const componentType = params.componentType as string;
    const handler = handlers[componentType];

    if (!handler) {
      send({
        id: request.id,
        error: { message: `this plugin does not provide "${componentType}"` },
      });
      return;
    }

    try {
      const node = (params.node ?? params.component ?? {}) as Record<string, unknown>;
      const ctx: ServeContext = {
        runTool,
        node,
        phase: params.phase as 'pre' | 'post' | undefined,
      };

      const result =
        request.method === 'apply'
          ? await (handler as TransformHandler).apply(
              (params.messages ?? []) as unknown[],
              ctx,
            )
          : await (handler as NodeHandler).execute(
              (params.input ?? {}) as Record<string, unknown>,
              ctx,
            );

      send({ id: request.id, result });
    } catch (err) {
      send({
        id: request.id,
        error: {
          name: err instanceof Error ? err.name : 'Error',
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  };

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let message: Message;
      try {
        message = JSON.parse(line) as Message;
      } catch {
        process.stderr.write(`plugin received a line that is not JSON: ${line.slice(0, 200)}\n`);
        continue;
      }

      if (typeof message.method === 'string') {
        void handle(message);
        continue;
      }
      // A response to one of our own runTool calls.
      const waiting = pending.get(String(message.id));
      if (waiting) {
        pending.delete(String(message.id));
        waiting(message);
      }
    }
  });

  // heddle closes stdin to say the run is over.
  process.stdin.on('end', () => process.exit(0));
}
