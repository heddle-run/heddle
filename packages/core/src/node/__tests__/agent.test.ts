import { describe, it, expect, vi, beforeEach } from 'vitest';

const chatCompletion = vi.fn();

import { AgentExecutor } from '../agent.js';
import { State } from '../../state/state.js';
import type { Dependencies } from '../types.js';
import type { AgentNode } from '../../spec/types.js';
import type { Event } from '../../runner/events.js';

const NODE: AgentNode = {
  componentType: 'AgentNode',
  name: 'assistant',
  agent: {
    componentType: 'Agent',
    name: 'assistant',
    systemPrompt: 'be useful',
    llmConfig: { componentType: 'OpenAiConfig', modelId: 'gpt-4o' },
    tools: [{ componentType: 'ServerTool', name: 'echo', description: 'echoes' }],
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
      const executor = new AgentExecutor(NODE, deps);
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
