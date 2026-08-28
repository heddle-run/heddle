import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatCompletion = vi.fn();

import { AgentExecutor } from '../agent.js';
import { State } from '../../state/state.js';
import { RunError } from '../../errors.js';
import type { Dependencies } from '../types.js';
import type { AgentStep, SchemaMap } from '../../spec/types.js';
import type { ChatRequest } from '../../llm/types.js';
import type { Event } from '../../runner/events.js';

const STEP: AgentStep = {
  kind: 'agent',
  name: 'assistant',
  agent: {
    model: { provider: 'openai', model: 'gpt-4o', extra: {} },
    prompt: 'be useful',
    tools: [{ name: 'echo', description: 'echoes', inputs: {}, outputs: {} }],
    transforms: [],
  },
};

interface Harness {
  events: Event[];
  received: Record<string, unknown>[];
  run(): Promise<Record<string, unknown>>;
}

function harness(args: unknown): Harness {
  const events: Event[] = [];
  const received: Record<string, unknown>[] = [];

  chatCompletion
    .mockResolvedValueOnce({
      content: '',
      tool_calls: [{ id: 'call_1', name: 'echo', arguments: args }],
    })
    .mockResolvedValueOnce({ content: 'all done', tool_calls: [] });

  const deps: Dependencies = {
    createProvider: () => ({ chatCompletion }),
    eventHandler: (e) => events.push(e),
    toolRegistry: {
      lookup: (name) =>
        name === 'echo' ? { name, description: 'echoes', impl: { kind: 'path' as const, path: '/echo' } } : undefined,
      all: () => [],
    },
    toolExecutor: {
      execute: async (_signal, _path, input) => {
        received.push(input);
        return { output: { echoed: input }, stderr: '' };
      },
    },
  };

  return {
    events,
    received,
    run: async () => {
      const executor = new AgentExecutor(STEP, deps);
      const state = await executor.execute(undefined, new State({ q: 'hi' }));
      return state.toData();
    },
  };
}

const toolCall = (events: Event[]): Event | undefined =>
  events.find((e) => e.type === 'tool_call');
const toolResult = (events: Event[]): Event | undefined =>
  events.find((e) => e.type === 'tool_result');

beforeEach(() => {
  chatCompletion.mockReset();
});

describe('tool call arguments', () => {
  it('reports the arguments the tool was actually run with', async () => {
    const h = harness('{"v": 41, "nested": {"deep": true}}');
    await h.run();

    expect(h.received).toEqual([{ v: 41, nested: { deep: true } }]);
    expect(toolCall(h.events)).toMatchObject({
      toolName: 'echo',
      toolArgs: { v: 41, nested: { deep: true } },
    });
    expect(toolCall(h.events)?.toolArgs).toBe(h.received[0]);
  });

  it('does not run the tool when the arguments are not JSON', async () => {
    const h = harness('{"v": ');
    await h.run();

    expect(h.received).toEqual([]);
    expect(toolResult(h.events)?.error?.message).toMatch(/are not JSON/);
  });

  it('announces the call it is about to fail, so the result has a pair', async () => {
    const h = harness('not json at all');
    await h.run();

    expect(toolCall(h.events)).toMatchObject({ toolName: 'echo', toolArgs: {} });
    expect(toolResult(h.events)).toMatchObject({ toolCallId: 'call_1' });
  });

  it('refuses arguments that are not a JSON object', async () => {
    const h = harness('[1, 2, 3]');
    await h.run();

    expect(h.received).toEqual([]);
    expect(toolResult(h.events)?.error?.message).toMatch(
      /called with an array.*JSON object of named arguments/,
    );
  });

  it('refuses a null arguments blob rather than passing it on as named arguments', async () => {
    const h = harness('null');
    await h.run();

    expect(h.received).toEqual([]);
    expect(toolResult(h.events)?.error?.message).toMatch(/called with null/);
  });

  it('survives an endpoint that omits the arguments field', async () => {
    const h = harness(undefined);
    const data = await h.run();

    expect(h.received).toEqual([]);
    expect(toolCall(h.events)).toMatchObject({ toolName: 'echo', toolArgs: {} });
    expect(toolResult(h.events)?.error?.message).toMatch(/are not JSON/);
    expect(data).toMatchObject({ result: 'all done' });
  });

  it('survives an endpoint that sends arguments already decoded', async () => {
    const h = harness({ v: 41 });
    const data = await h.run();

    expect(h.received).toEqual([]);
    expect(toolResult(h.events)?.error?.message).toMatch(/are not JSON/);
    expect(data).toMatchObject({ result: 'all done' });
  });

  it('names the absence instead of trailing off, when there was nothing to quote', async () => {
    const h = harness('');
    await h.run();

    expect(toolResult(h.events)?.error?.message).toMatch(/Got: nothing at all$/);
  });

  it('tells the model what went wrong so it can try again', async () => {
    const h = harness('{"v": ');
    const data = await h.run();

    expect(data).toMatchObject({ result: 'all done' });

    const followUp = chatCompletion.mock.calls.at(-1);
    const messages = (followUp?.[1] as { messages: { role: string; content: string }[] })
      .messages;
    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toMatch(/Send a JSON object of named arguments/);
  });
});

/**
 * Structured output: opt-in through `output:`, enforced rather than guessed.
 * The old behavior — merging whatever JSON keys the answer happened to carry —
 * is gone; a step's shape is declared or its output is the one `result` string.
 */
describe('a declared output', () => {
  function structured(
    answer: string,
    output: SchemaMap = { status: 'string', note: 'string' } as never,
  ): { run: () => Promise<Record<string, unknown>>; sent: () => ChatRequest } {
    chatCompletion.mockResolvedValueOnce({ content: answer, tool_calls: [] });

    const step: AgentStep = {
      kind: 'agent',
      name: 'triage',
      agent: {
        model: { provider: 'openai', model: 'gpt-4o', extra: {} },
        prompt: 'triage {{inputs.alert}}',
        tools: [],
        transforms: [],
        output: normalized(output),
      },
    };

    const executor = new AgentExecutor(step, {
      createProvider: () => ({ chatCompletion }),
    });

    return {
      run: async () => {
        const state = await executor.execute(
          undefined,
          new State({ 'inputs.alert': 'disk full' }),
        );
        return state.toData();
      },
      sent: () => chatCompletion.mock.calls[0][1] as ChatRequest,
    };
  }

  /** Accepts the shorthand `{ status: 'string' }` for readable cases above. */
  function normalized(output: SchemaMap): SchemaMap {
    return Object.fromEntries(
      Object.entries(output).map(([key, value]) => [
        key,
        typeof value === 'string' ? { type: value } : value,
      ]),
    ) as SchemaMap;
  }

  it('writes exactly the declared keys, never result', async () => {
    const h = structured('{"status": "ok", "note": "disk on db-1"}');

    expect(await h.run()).toEqual({ status: 'ok', note: 'disk on db-1' });
  });

  it('asks the endpoint for JSON and tells the model the keys', async () => {
    const h = structured('{"status": "ok", "note": "n"}');
    await h.run();

    const request = h.sent();
    expect(request.responseFormat).toBe('json');
    const system = request.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toMatch(/exactly these keys/);
    expect(system.content).toContain('"status": string');
    expect(system.content).toContain('"note": string');
  });

  it('drops keys the answer smuggled in beside the declared ones', async () => {
    const h = structured('{"status": "ok", "note": "n", "extra": "no"}');

    expect(await h.run()).toEqual({ status: 'ok', note: 'n' });
  });

  it('fails the step when a declared key is missing from the answer', async () => {
    const h = structured('{"status": "ok"}');

    await expect(h.run()).rejects.toThrow(RunError);

    const again = structured('{"status": "ok"}');
    await expect(again.run()).rejects.toThrow(/missing declared output key "note"/);
  });

  it('fails the step when the answer is not a JSON object at all', async () => {
    const h = structured('the disk is full');

    await expect(h.run()).rejects.toThrow(
      /agent step "triage" declares a structured output/,
    );
  });

  it('unfences a ```json answer, the one lenience it allows', async () => {
    const h = structured('```json\n{"status": "ok", "note": "n"}\n```');

    expect(await h.run()).toEqual({ status: 'ok', note: 'n' });
  });

  it('sends the referenced values, and only those, as the user message', async () => {
    const h = structured('{"status": "ok", "note": "n"}');
    await h.run();

    const user = h.sent().messages.at(-1);
    expect(user?.role).toBe('user');
    expect(JSON.parse(user?.content ?? '')).toEqual({
      'inputs.alert': 'disk full',
    });
  });
});
