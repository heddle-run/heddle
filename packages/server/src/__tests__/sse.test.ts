/**
 * What survives the trip from a runner event to a client.
 *
 * `serializeEvent` copies a fixed list of fields, so a field added to `Event`
 * and forgotten here is dropped with no type error and no warning — the engine
 * emits it, the browser never sees it, and nothing anywhere says so. That is
 * not hypothetical: `message` was missing, which meant every `warning` frame
 * reached clients empty. These tests are the list.
 */
import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { Event } from '@heddle/core';
import { State } from '@heddle/core';
import { SseStream, serializeEvent } from '../sse.js';

/** Every field an `Event` can carry, populated. */
const FULL: Event = {
  type: 'tool_result',
  message: 'a warning worth reading',
  delta: 'the ',
  nodeName: 'assistant',
  nodeType: 'AgentNode',
  state: new State({ result: 41 }),
  error: new Error('it broke'),
  toolName: 'echo',
  toolArgs: { v: 41 },
  toolResult: { echoed: 41 },
  toolCallId: 'call_1',
  startedAt: 1,
  duration: 2,
};

/** Collects the frames an SseStream writes, parsed back out of the wire form. */
function collector(): {
  res: ServerResponse;
  frames: () => { event: string; data: unknown }[];
} {
  const written: string[] = [];
  const res = {
    writeHead: () => undefined,
    flushHeaders: () => undefined,
    write: (chunk: string) => written.push(chunk),
    end: () => undefined,
  } as unknown as ServerResponse;

  return {
    res,
    frames: () =>
      written.map((frame) => {
        const [head, body] = frame.split('\n');
        return {
          event: head.replace('event: ', ''),
          data: JSON.parse(body.replace('data: ', '')),
        };
      }),
  };
}

describe('serializeEvent', () => {
  it('drops no field an event can carry', async () => {
    const wire = serializeEvent(FULL);

    for (const field of Object.keys(FULL)) {
      expect(wire[field], `"${field}" never reaches the client`).toBeDefined();
    }
  });

  it('carries a token delta through the wire form unchanged', () => {
    const c = collector();
    const stream = new SseStream(c.res);
    stream.open();

    const delta: Event = { type: 'token_delta', nodeName: 'assistant', delta: 'the ' };
    stream.send(delta.type, serializeEvent(delta));

    // Trailing whitespace matters: deltas are concatenated by whoever receives
    // them, and a transport that trims turns "the answer" into "theanswer".
    expect(c.frames()).toEqual([
      {
        event: 'token_delta',
        data: { type: 'token_delta', nodeName: 'assistant', delta: 'the ' },
      },
    ]);
  });

  it('carries the text of a warning, which is the only thing a warning has', () => {
    const wire = serializeEvent({
      type: 'warning',
      nodeName: 'assistant',
      message: 'the model stream failed after 3 token deltas',
    });

    expect(wire.message).toBe('the model stream failed after 3 token deltas');
  });

  it('turns the two things JSON cannot carry into things it can', () => {
    const wire = serializeEvent(FULL);

    expect(wire.state).toEqual({ result: 41 });
    expect(wire.error).toEqual({ name: 'Error', message: 'it broke' });
  });
});
