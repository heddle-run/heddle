/**
 * An OpenAI-compatible endpoint that answers instantly.
 *
 * The point of the benchmark is to measure heddle, and a real model call is
 * 500ms-20s of network latency that would bury every difference worth seeing.
 * This stands in for the model so what remains on the clock is compile,
 * traverse, serialize and spawn -- the parts a runtime change can move.
 *
 * Deliberately runs on Node for every benchmark, whichever runtime is under
 * test, so the load generator and the model stub are constants.
 *
 *   node bench/fake-llm.mjs --port 4400 [--latency 0] [--reply-bytes 256]
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '4400' },
    latency: { type: 'string', default: '0' },
    'reply-bytes': { type: 'string', default: '256' },
  },
});

const port = Number(values.port);
const latency = Number(values.latency);
const replyBytes = Number(values['reply-bytes']);

// Built once. Allocating the reply per request would put the stub's own
// garbage into the measurement.
const CONTENT = 'x'.repeat(replyBytes);

function completion() {
  return JSON.stringify({
    id: 'chatcmpl-bench',
    object: 'chat.completion',
    created: 0,
    model: 'bench-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: CONTENT },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

const server = createServer((req, res) => {
  // Drain the body: the client will not see the response until it is consumed,
  // and the request carries the whole message history.
  req.resume();
  req.on('end', () => {
    const send = () => {
      const payload = completion();
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      });
      res.end(payload);
    };
    if (latency > 0) setTimeout(send, latency);
    else send();
  });
});

// Hold connections open across runs: the stub should never be the thing that
// makes the client pay for a fresh socket.
server.keepAliveTimeout = 60_000;

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake-llm listening on 127.0.0.1:${port}\n`);
});
