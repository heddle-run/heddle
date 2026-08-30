import { PROTOCOL_VERSION } from './protocol.js';
import { makeServe } from './serve-impl.js';

/**
 * The stdio runtime a subprocess plugin is started with.
 *
 * The dispatch itself lives in `serve-impl.ts` and serves both transports;
 * what this module adds is the stdio shell — line-buffered NDJSON over
 * stdin/stdout, logs rerouted to stderr, `process.exit(0)` when the host says
 * stop — and the embedding. `makeServe` is written to be self-contained (no
 * imports, no captured module scope, nothing that does not erase to plain
 * ES2022), so `Function.prototype.toString` on the *built* function is its
 * own codegen step: whatever tsup emitted is exactly what the child process
 * evaluates. The subprocess plugin tests spawn real node children through
 * this string and are the check that the property survives transpilation.
 */
export const PLUGIN_RUNTIME_JS = `
const HEDDLE_MAKE_SERVE = ${makeServe.toString()};

function serve(handlers, options) {
  let onHostMessage = () => {};
  let onHostEnd = () => {};
  const io = {
    redirectConsole: true,
    send: (message) => process.stdout.write(JSON.stringify(message) + '\\n'),
    onMessage: (handler) => { onHostMessage = handler; },
    onEnd: (handler) => { onHostEnd = handler; },
    stderr: (text) => process.stderr.write(text),
    exit: () => process.exit(0),
  };
  HEDDLE_MAKE_SERVE(io, ${PROTOCOL_VERSION})(handlers, options);

  let buffer = '';
  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write('plugin received a line that is not JSON: ' + line.slice(0, 200) + '\\n');
        continue;
      }
      onHostMessage(message);
    }
  });

  process.stdin.on('end', () => onHostEnd());
}
`;

export function withRuntime(source: string): string {
  return `${PLUGIN_RUNTIME_JS}\n${source}\n`;
}
