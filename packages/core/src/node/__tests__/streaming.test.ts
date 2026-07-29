/**
 * Streaming as seen from inside a node.
 *
 * The property under test is indistinguishability: a provider that streams and
 * a provider that does not must leave the node in the same state, run the same
 * tools with the same arguments, and produce the same output. Streaming is
 * allowed to change *when* a client learns things, and nothing else.
 *
 * The exception is failure, which streaming genuinely does change: a buffered
 * call fails before anyone has seen anything, and a stream can fail after half
 * an answer is already on someone's screen. That case gets its own tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { chatCompletion, chatCompletionStream } = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
  chatCompletionStream: vi.fn(),
}));

/**
 * Streaming is opt-in per provider, so the stub has to be able to *not* have
 * the method — `streams(false)` deletes it rather than stubbing it, because a
 * present-but-unused method would not exercise the fallback at all.
 */
let streaming = true;
const stubProvider = (): Provider =>
  streaming ? { chatCompletion, chatCompletionStream } : { chatCompletion };

import { AgentExecutor, collectStream, completeChat } from '../agent.js';
import { TransformChain } from '../../plugin/transform.js';
import { LLMExecutor } from '../llm.js';
import { State } from '../../state/state.js';
import type { Dependencies } from '../types.js';
import type { AgentNode, LLMNode } from '../../spec/types.js';
import type { Event } from '../../runner/events.js';
import type { ChatChunk, Provider } from '../../llm/types.js';

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

const LLM_NODE: LLMNode = {
  componentType: 'LlmNode',
  name: 'writer',
  promptTemplate: 'write about {{q}}',
  llmConfig: { componentType: 'OpenAiConfig', modelId: 'gpt-4o' },
};

/** A stream of the given chunks, failing at the end if `failWith` is given. */
function chunks(parts: ChatChunk[], failWith?: Error): AsyncIterable<ChatChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
      if (failWith) throw failWith;
    },
  };
}

/** Text split into one chunk per word, the way a model actually sends it. */
const words = (sentence: string): ChatChunk[] =>
  sentence.split(/(?<= )/).map((content) => ({ content }));

interface Harness {
  events: Event[];
  received: Record<string, unknown>[];
  run(): Promise<Record<string, unknown>>;
  deltas(): string[];
}

function harness(): Harness {
  const events: Event[] = [];
  const received: Record<string, unknown>[] = [];

  const deps: Dependencies = {
    createProvider: stubProvider,
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
    deltas: () =>
      events.filter((e) => e.type === 'token_delta').map((e) => e.delta ?? ''),
    run: async () => {
      const executor = new AgentExecutor(NODE, deps);
      const state = await executor.execute(undefined, new State({ q: 'hi' }));
      return state.toData();
    },
  };
}

beforeEach(() => {
  chatCompletion.mockReset();
  chatCompletionStream.mockReset();
  streaming = true;
});

describe('collectStream', () => {
  it('assembles a tool call from fragments that only share an index', async () => {
    const resp = await collectStream(
      chunks([
        { tool_calls: [{ index: 0, id: 'call_1', name: 'echo', arguments: '' }] },
        { tool_calls: [{ index: 0, arguments: '{"v":' }] },
        { tool_calls: [{ index: 0, arguments: ' 41}' }] },
        { finish_reason: 'tool_calls' },
      ]),
    );

    expect(resp).toEqual({
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [{ id: 'call_1', name: 'echo', arguments: '{"v": 41}' }],
    });
  });

  it('orders tool calls by index, not by which one finished first', async () => {
    // A provider is free to interleave, and the second call can complete
    // first. The model asked for them in index order and that is the order the
    // loop has to run them in.
    const resp = await collectStream(
      chunks([
        {
          tool_calls: [
            { index: 1, id: 'b', name: 'second', arguments: '{"y":2}' },
            { index: 0, id: 'a', name: 'first' },
          ],
        },
        { tool_calls: [{ index: 0, arguments: '{"x":1}' }] },
      ]),
    );

    expect(resp.tool_calls?.map((tc) => tc.name)).toEqual(['first', 'second']);
    expect(resp.tool_calls?.[0].arguments).toBe('{"x":1}');
  });

  it('leaves tool_calls absent when the model called nothing', async () => {
    // Not `[]`. The agent loop branches on this, and an empty array is a
    // different response from the one the buffered path returns.
    const resp = await collectStream(chunks(words('all done')));

    expect(resp).toEqual({ content: 'all done', finish_reason: '' });
    expect('tool_calls' in resp).toBe(false);
  });

  it('announces text as it arrives, and only text', async () => {
    const seen: string[] = [];
    await collectStream(
      chunks([
        { content: 'Hel' },
        { tool_calls: [{ index: 0, arguments: '{"v":1}' }] },
        { content: 'lo' },
      ]),
      (t) => seen.push(t),
    );

    // Half-written tool arguments are not text for a person to read.
    expect(seen).toEqual(['Hel', 'lo']);
  });
});

describe('a streamed agent turn', () => {
  it('produces what the same turn would produce without streaming', async () => {
    chatCompletionStream.mockReturnValueOnce(
      chunks([...words('the answer is 41'), { finish_reason: 'stop' }]),
    );
    const streamed = await harness().run();

    streaming = false;
    chatCompletion.mockResolvedValueOnce({
      content: 'the answer is 41',
      finish_reason: 'stop',
    });
    const buffered = await harness().run();

    expect(streamed).toEqual(buffered);
  });

  it('runs the tool with the arguments the fragments spelled out', async () => {
    chatCompletionStream
      .mockReturnValueOnce(
        chunks([
          { tool_calls: [{ index: 0, id: 'call_1', name: 'echo' }] },
          { tool_calls: [{ index: 0, arguments: '{"v": 4' }] },
          { tool_calls: [{ index: 0, arguments: '1}' }] },
          { finish_reason: 'tool_calls' },
        ]),
      )
      .mockReturnValueOnce(chunks(words('all done')));

    const h = harness();
    const data = await h.run();

    expect(h.received).toEqual([{ v: 41 }]);
    expect(data).toMatchObject({ result: 'all done' });
    // The tool_call event is unchanged by streaming: an observer sees the
    // assembled arguments, once, at the moment the tool runs.
    const calls = h.events.filter((e) => e.type === 'tool_call');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ toolName: 'echo', toolArgs: { v: 41 } });
  });

  it('emits a delta per fragment, naming the node they belong to', async () => {
    chatCompletionStream.mockReturnValueOnce(chunks(words('the answer is 41')));

    const h = harness();
    const data = await h.run();

    expect(h.deltas()).toEqual(['the ', 'answer ', 'is ', '41']);
    expect(h.deltas().join('')).toBe(data.result);
    expect(
      h.events.filter((e) => e.type === 'token_delta').every((e) => e.nodeName === 'assistant'),
    ).toBe(true);
  });

  it('emits nothing extra for the round that only called a tool', async () => {
    chatCompletionStream
      .mockReturnValueOnce(
        chunks([
          {
            tool_calls: [
              { index: 0, id: 'call_1', name: 'echo', arguments: '{"v":1}' },
            ],
          },
        ]),
      )
      .mockReturnValueOnce(chunks(words('all done')));

    const h = harness();
    await h.run();

    expect(h.deltas()).toEqual(['all ', 'done']);
  });

  it('falls back to the buffered call when the provider cannot stream', async () => {
    streaming = false;
    chatCompletion.mockResolvedValueOnce({ content: 'all done', finish_reason: 'stop' });

    const h = harness();
    const data = await h.run();

    expect(data).toMatchObject({ result: 'all done' });
    expect(h.deltas()).toEqual([]);
    expect(chatCompletion).toHaveBeenCalledOnce();
  });

  it('streams an LlmNode too, and still writes generated_text', async () => {
    chatCompletionStream.mockReturnValueOnce(chunks(words('a poem about hi')));

    const events: Event[] = [];
    const executor = new LLMExecutor(LLM_NODE, {
      createProvider: stubProvider,
      eventHandler: (e) => events.push(e),
    });
    const out = await executor.execute(undefined, new State({ q: 'hi' }));

    expect(out.toData()).toEqual({ generated_text: 'a poem about hi' });
    expect(events.filter((e) => e.type === 'token_delta').map((e) => e.delta)).toEqual([
      'a ',
      'poem ',
      'about ',
      'hi',
    ]);
  });
});

describe('a stream that fails part way', () => {
  it('fails the node rather than passing off a truncated answer as the result', async () => {
    chatCompletionStream.mockReturnValueOnce(
      chunks(words('the answer is'), new Error('upstream connect error')),
    );

    const h = harness();
    await expect(h.run()).rejects.toThrow(/upstream connect error/);
    // The text went out; it is emphatically not the node's output.
    expect(h.deltas()).toEqual(['the ', 'answer ', 'is']);
  });

  it('warns that the deltas already sent are being abandoned', async () => {
    chatCompletionStream.mockReturnValueOnce(
      chunks(words('the answer is'), new Error('upstream connect error')),
    );

    const h = harness();
    await h.run().catch(() => undefined);

    const warning = h.events.find((e) => e.type === 'warning');
    // A client holding half an answer and a dead stream cannot otherwise tell
    // a truncated answer from a finished one.
    expect(warning?.message).toMatch(/3 token deltas/);
    expect(warning?.message).toMatch(/upstream connect error/);
    expect(h.events.indexOf(warning!)).toBeGreaterThan(
      h.events.findIndex((e) => e.type === 'token_delta'),
    );
  });

  it('stays quiet when the stream failed before anything was shown', async () => {
    // Nothing was sent, so there is nothing to retract: this is an ordinary
    // model failure and warning about it would be noise on every bad API key.
    chatCompletionStream.mockReturnValueOnce(
      chunks([], new Error('401 Incorrect API key provided')),
    );

    const h = harness();
    await expect(h.run()).rejects.toThrow(/401/);
    expect(h.events.filter((e) => e.type === 'warning')).toEqual([]);
  });

  it('does not retry the call it already billed for', async () => {
    chatCompletionStream.mockReturnValueOnce(
      chunks(words('half an'), new Error('upstream connect error')),
    );

    await harness().run().catch(() => undefined);

    expect(chatCompletionStream).toHaveBeenCalledOnce();
    expect(chatCompletion).not.toHaveBeenCalled();
  });
});

/**
 * The two vetoes, and why they exist.
 *
 * A `post` transform can reject the model's answer, and heddle's guardrail
 * story is that `transform_status: rejected` means the answer did not get out.
 * A delta is already out. The operator's switch is the other one: whether
 * `stream: true` is safe is a property of the endpoint, not the flow.
 */
describe('when streaming is vetoed', () => {
  const provider = (): Provider =>
    ({ chatCompletion, chatCompletionStream }) as unknown as Provider;

  beforeEach(() => {
    streaming = true;
    chatCompletion.mockReset();
    chatCompletionStream.mockReset();
  });

  it('buffers, and shows nothing, when the caller forbids it', async () => {
    chatCompletion.mockResolvedValueOnce({ content: 'buffered', finish_reason: 'stop' });
    const events: Event[] = [];

    const resp = await completeChat(
      provider(),
      undefined,
      { model: 'gpt-4o', messages: [] },
      { nodeName: 'guarded', eventHandler: (e) => events.push(e), allowStream: false },
    );

    expect(resp.content).toBe('buffered');
    expect(chatCompletionStream).not.toHaveBeenCalled();
    // The point of the exercise: nothing left the process before the transform
    // that may reject it has had a say.
    expect(events).toEqual([]);
  });

  it('streams when nothing forbids it', async () => {
    chatCompletionStream.mockReturnValueOnce(chunks(words('let it flow')));
    const events: Event[] = [];

    await completeChat(
      provider(),
      undefined,
      { model: 'gpt-4o', messages: [] },
      { nodeName: 'open', eventHandler: (e) => events.push(e) },
    );

    expect(events.filter((e) => e.type === 'token_delta')).not.toEqual([]);
    expect(chatCompletion).not.toHaveBeenCalled();
  });

  it('knows whether a chain has anything in the post phase', () => {
    expect(TransformChain.build([], {}, 'none').hasPhase('post')).toBe(false);
  });
});

/**
 * The abandonment warning is about what a person is looking at, and a turn is
 * several model calls.
 */
describe('deltas abandoned across rounds', () => {
  beforeEach(() => {
    streaming = true;
    chatCompletion.mockReset();
    chatCompletionStream.mockReset();
  });

  it('warns when an earlier round streamed and a later one fails silently', async () => {
    const events: Event[] = [];
    const turn = { emitted: 0 };
    const provider = { chatCompletion, chatCompletionStream } as unknown as Provider;
    const ctx = { nodeName: 'assistant', eventHandler: (e: Event) => events.push(e), turn };

    // Round one: text reaches the client.
    chatCompletionStream.mockReturnValueOnce(chunks(words('looking that up ')));
    await completeChat(provider, undefined, { model: 'gpt-4o', messages: [] }, ctx);

    // Round two: dies before writing a single delta of its own.
    chatCompletionStream.mockReturnValueOnce(chunks([], new Error('upstream reset')));
    await expect(
      completeChat(provider, undefined, { model: 'gpt-4o', messages: [] }, ctx),
    ).rejects.toThrow(/upstream reset/);

    const warnings = events.filter((e) => e.type === 'warning');
    expect(warnings).toHaveLength(1);
    // Round one's count, not round two's zero — that text is still on screen.
    expect(warnings[0].message).toMatch(/after 3 token deltas/);
  });
});
