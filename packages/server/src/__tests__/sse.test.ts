import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import type { Event } from '@heddle-run/core';
import { State } from '@heddle-run/core';
import { SseStream, serializeEvent } from '../sse.js';

const FULL: Required<Event> = {
  type: 'tool_result',
  message: 'a warning worth reading',
  delta: 'the ',
  data: { done: 3, total: 10 },
  level: 'warn',
  nodeName: 'assistant',
  nodeType: 'AgentNode',
  state: new State({ result: 41 }),
  error: new Error('it broke'),
  attempt: 2,
  toolName: 'echo',
  toolArgs: { v: 41 },
  toolResult: { echoed: 41 },
  toolCallId: 'call_1',
  startedAt: 1,
  duration: 2,
};

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

describe('plugin events on the wire', () => {
  it('carries a plugin event whole, with its namespaced type as the frame name', () => {
    const c = collector();
    const stream = new SseStream(c.res);
    stream.open();

    const event: Event = {
      type: 'plugin:LlmJudge:progress',
      nodeName: 'judge',
      nodeType: 'LlmJudge',
      data: { scored: 3, of: 10 },
    };
    stream.send(event.type, serializeEvent(event));

    expect(c.frames()).toEqual([
      {
        event: 'plugin:LlmJudge:progress',
        data: {
          type: 'plugin:LlmJudge:progress',
          nodeName: 'judge',
          nodeType: 'LlmJudge',
          data: { scored: 3, of: 10 },
        },
      },
    ]);
  });

  it('carries a log line, which is the whole of what a client renders', () => {
    const wire = serializeEvent({
      type: 'plugin_log',
      nodeName: 'judge',
      nodeType: 'LlmJudge',
      level: 'warn',
      message: 'the third row had no id; skipping it',
    });

    expect(wire.level).toBe('warn');
    expect(wire.message).toBe('the third row had no id; skipping it');
  });

  it('will not let an event name write a frame of its own', () => {
    const c = collector();
    const stream = new SseStream(c.res);
    stream.open();

    stream.send('plugin:X:a\n\nevent: flow_complete\ndata: {}', { type: 'x' });

    expect(c.frames()).toHaveLength(1);
    expect(c.frames()[0].event).not.toContain('\n');
  });
});
