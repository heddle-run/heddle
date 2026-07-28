/**
 * The agent turn's tool-calling loop.
 *
 * The arguments a model sends with a tool call used to be read twice: once
 * leniently, to fill in the `tool_call` event, and once strictly, to run the
 * tool. The two disagreed exactly when it mattered — a malformed blob was
 * reported to observers as `{}` and never ran at all. These tests pin the two
 * together, because every hook the roadmap adds to this loop is handed that
 * same parse.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// No credentials: the provider is stubbed, so the loop can be driven through
// tool rounds without a model.
const { chatCompletion } = vi.hoisted(() => ({ chatCompletion: vi.fn() }));
// Partial: only `createProvider` needs a stand-in. `generationParams` reads the
// spec and returns a plain object, so replacing it would be replacing the thing
// under test in the cases below that set generation parameters.
vi.mock('../../llm/provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm/provider.js')>()),
  createProvider: () => ({ chatCompletion }),
}));

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
  /** Every argument object the tool executor was actually handed. */
  received: Record<string, unknown>[];
  run(): Promise<Record<string, unknown>>;
}

/**
 * Drives one turn in which the model asks for `echo` with `args`, then answers.
 *
 * `args` is `unknown` rather than `string` because the endpoint is what decides
 * what arrives here, not heddle's types: a spec picks its own `llm_config.url`,
 * so a tool call with a missing or non-string `arguments` is a response shape
 * these tests have to be able to express.
 */
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
    eventHandler: (e) => events.push(e),
    toolRegistry: {
      lookup: (name) =>
        name === 'echo' ? { name, description: 'echoes', path: '/echo' } : undefined,
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
    // Identity, not deep equality: two separate readings of the same blob would
    // pass a `toEqual` here and still be free to disagree on the next one.
    expect(toolCall(h.events)?.toolArgs).toBe(h.received[0]);
  });

  it('does not run the tool when the arguments are not JSON', async () => {
    const h = harness('{"v": ');
    await h.run();

    expect(h.received).toEqual([]);
    expect(toolResult(h.events)?.error?.message).toMatch(/are not JSON/);
  });

  it('announces the call it is about to fail, so the result has a pair', async () => {
    // An observer that sees a tool_result with no tool_call cannot say which
    // call failed. The event still fires; it just reports no arguments.
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
    // Passes on its own, and pins which branch is doing the saving: `null`
    // parses fine, so only the non-object check keeps it away from the tool.
    const h = harness('null');
    await h.run();

    expect(h.received).toEqual([]);
    expect(toolResult(h.events)?.error?.message).toMatch(/called with null/);
  });

  it('survives an endpoint that omits the arguments field', async () => {
    // `ToolCall.arguments` is typed `string`, but a spec chooses its own
    // `llm_config.url` and the field is copied straight out of that server's
    // JSON. An endpoint that sends a tool call with no `arguments` used to
    // throw a TypeError out of the agent node, killing the run — no
    // `tool_call` event, no `tool_result`, nothing for the model to correct.
    const h = harness(undefined);
    const data = await h.run();

    expect(h.received).toEqual([]);
    expect(toolCall(h.events)).toMatchObject({ toolName: 'echo', toolArgs: {} });
    expect(toolResult(h.events)?.error?.message).toMatch(/are not JSON/);
    expect(data).toMatchObject({ result: 'all done' });
  });

  it('survives an endpoint that sends arguments already decoded', async () => {
    // The other shape the same lie takes: a server that sends the arguments as
    // a JSON object instead of a JSON string. Recoverable, not fatal.
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

    // The turn continues: a bad tool call is a message back to the model, not
    // the end of the agent.
    expect(data).toMatchObject({ result: 'all done' });

    const followUp = chatCompletion.mock.calls.at(-1);
    const messages = (followUp?.[1] as { messages: { role: string; content: string }[] })
      .messages;
    const toolMessage = messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toMatch(/Send a JSON object of named arguments/);
  });
});
