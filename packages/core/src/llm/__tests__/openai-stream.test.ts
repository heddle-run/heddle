/**
 * The streaming half of the provider contract, at the OpenAI boundary.
 *
 * What is pinned here is the translation: what the SDK hands over in fragments
 * versus what a consumer of `ChatChunk` is entitled to assume. The tool-call
 * shape is the part worth guarding — the SDK identifies a call by its position
 * in the turn and sends its name once, so a translation that keyed on `id`
 * would look correct against a single-tool transcript and merge two calls into
 * one against a real one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type OpenAI from 'openai';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

import { OpenAIProvider } from '../openai.js';
import { LLMError } from '../../errors.js';
import type { ChatChunk, ChatRequest } from '../types.js';

type Choice = OpenAI.Chat.Completions.ChatCompletionChunk.Choice;
type Part = { choices?: Partial<Choice>[] };

const REQ: ChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'hi' }],
};

/** A stream that yields the given parts, then optionally fails. */
function streamOf(parts: Part[], failWith?: Error): AsyncIterable<Part> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const part of parts) yield part;
      if (failWith) throw failWith;
    },
  };
}

function serves(parts: Part[], failWith?: Error): void {
  create.mockResolvedValue(streamOf(parts, failWith));
}

/** Text-only deltas, the common case. */
const text = (...words: string[]): Part[] =>
  words.map((content) => ({ choices: [{ delta: { content } }] }));

async function drain(
  stream: AsyncIterable<ChatChunk>,
): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

const provider = (): OpenAIProvider => new OpenAIProvider();

beforeEach(() => {
  create.mockReset();
});

describe('chatCompletionStream', () => {
  it('asks the endpoint to stream, with the request the buffered call would send', async () => {
    serves(text('hi'));
    await drain(
      provider().chatCompletionStream(undefined, {
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ name: 'echo', description: 'echoes', parameters: {} }],
      }),
    );

    const [body] = create.mock.calls[0] as [Record<string, unknown>];
    expect(body).toMatchObject({
      stream: true,
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.tools).toHaveLength(1);
  });

  it('sends nothing until the caller iterates', async () => {
    serves(text('hi'));
    const stream = provider().chatCompletionStream(undefined, REQ);

    // A stream created and abandoned would otherwise hold the connection open.
    expect(create).not.toHaveBeenCalled();

    await drain(stream);
    expect(create).toHaveBeenCalledOnce();
  });

  it('forwards content fragments in order', async () => {
    serves(text('Hello', ', ', 'world'));
    const chunks = await drain(provider().chatCompletionStream(undefined, REQ));

    expect(chunks.map((c) => c.content)).toEqual(['Hello', ', ', 'world']);
  });

  it('drops the opening frame that carries a role and nothing else', async () => {
    serves([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      ...text('hi'),
    ]);
    const chunks = await drain(provider().chatCompletionStream(undefined, REQ));

    expect(chunks).toEqual([{ content: 'hi' }]);
  });

  it('ignores chunks that carry no choice at all', async () => {
    // The usage-only trailer, and the preamble some compatible endpoints send.
    serves([{ choices: [] }, ...text('hi'), {}]);
    const chunks = await drain(provider().chatCompletionStream(undefined, REQ));

    expect(chunks).toEqual([{ content: 'hi' }]);
  });

  it('reports the terminal finish reason', async () => {
    serves([...text('hi'), { choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    const chunks = await drain(provider().chatCompletionStream(undefined, REQ));

    expect(chunks.at(-1)).toEqual({ finish_reason: 'stop' });
  });

  it('keeps a tool call identified by position while its arguments arrive', async () => {
    serves([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', function: { name: 'echo', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"v":' } }] } },
        ],
      },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '41}' } }] } },
        ],
      },
    ]);
    const chunks = await drain(provider().chatCompletionStream(undefined, REQ));

    // The name and id come once; every later fragment is bare argument text
    // that only the index ties back to the call it belongs to.
    expect(chunks.map((c) => c.tool_calls)).toEqual([
      [{ index: 0, id: 'call_1', name: 'echo', arguments: '' }],
      [{ index: 0, arguments: '{"v":' }],
      [{ index: 0, arguments: '41}' }],
    ]);
  });

  it('keeps two concurrent tool calls apart', async () => {
    serves([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'first', arguments: '{"x":1}' } },
                { index: 1, id: 'b', function: { name: 'second', arguments: '{"y":2}' } },
              ],
            },
          },
        ],
      },
    ]);
    const chunks = await drain(provider().chatCompletionStream(undefined, REQ));

    expect(chunks[0].tool_calls?.map((tc) => [tc.index, tc.name])).toEqual([
      [0, 'first'],
      [1, 'second'],
    ]);
  });

  it("carries the endpoint's own words when the stream fails part way", async () => {
    serves(text('Hel', 'lo'), new Error('upstream connect error'));

    const chunks: ChatChunk[] = [];
    const stream = provider().chatCompletionStream(undefined, REQ);
    await expect(
      (async () => {
        for await (const chunk of stream) chunks.push(chunk);
      })(),
    ).rejects.toThrow(/upstream connect error/);

    // The failure arrives after real output: that is the case the buffered
    // call never has, and callers are told about the deltas they already got.
    expect(chunks).toHaveLength(2);
  });

  it("carries the endpoint's own words when the request itself is refused", async () => {
    create.mockRejectedValue(new Error('401 Incorrect API key provided'));

    await expect(
      drain(provider().chatCompletionStream(undefined, REQ)),
    ).rejects.toThrow(/401 Incorrect API key provided/);
  });

  it('fails rather than returning a blank answer when no choice ever arrives', async () => {
    serves([{ choices: [] }]);

    await expect(
      drain(provider().chatCompletionStream(undefined, REQ)),
    ).rejects.toBeInstanceOf(LLMError);
  });
});
