/**
 * Generation parameters: from a spec, through a request, onto the wire.
 *
 * `default_generation_parameters` has been on `LLMConfig` since the type was
 * written and was read nowhere, so no spec could set a temperature or a token
 * ceiling on anything — not because anyone decided it should not, but because
 * `ChatRequest` had no field to put it in. This file covers the three places
 * that changed: the reading, the merging, and the one translation where
 * heddle's spelling becomes OpenAI's.
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
import { generationParams } from '../provider.js';
import { AgentExecutor } from '../../node/agent.js';
import { State } from '../../state/state.js';
import { LLMError } from '../../errors.js';
import type { AgentNode } from '../../spec/types.js';
import type { ChatRequest } from '../types.js';

const MESSAGES: ChatRequest['messages'] = [{ role: 'user', content: 'hi' }];

/** What the SDK was asked to send. */
function sent(): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  return create.mock.calls[0][0] as OpenAI.Chat.Completions.ChatCompletionCreateParams;
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
  });
});

describe('reading a spec’s generation parameters', () => {
  it('is empty when the spec sets none', () => {
    expect(generationParams({ modelId: 'm' })).toEqual({});
  });

  it('reads the three the SDK defines, under the SDK’s own names', () => {
    // camelCase, because that is what `LlmGenerationConfig` is after the SDK
    // deserializes it — so this mapping is an identity and not a rename that
    // could be got wrong in one direction.
    expect(
      generationParams({
        modelId: 'm',
        defaultGenerationParameters: { temperature: 0.2, maxTokens: 512, topP: 0.9 },
      }),
    ).toEqual({ temperature: 0.2, maxTokens: 512, topP: 0.9 });
  });

  it('drops a key it does not know, rather than failing the flow', () => {
    // `LlmGenerationConfig` is a passthrough schema, so a spec written for
    // another engine's parameters deserializes intact. Refusing those would
    // make heddle the only engine that cannot read such a spec at all.
    expect(
      generationParams({
        modelId: 'm',
        defaultGenerationParameters: { temperature: 0.2, presencePenalty: 1 },
      }),
    ).toEqual({ temperature: 0.2 });
  });

  it('refuses a value of the wrong type instead of ignoring it', () => {
    // The spec plainly says what it wants; running at the endpoint's default
    // while it says otherwise is the one outcome nobody can debug.
    expect(() =>
      generationParams({
        modelId: 'm',
        defaultGenerationParameters: { temperature: '0.7' },
      }),
    ).toThrow(/temperature is "0.7", which is not a number/);
  });

  it('treats an absent value as absent, not as zero', () => {
    expect(
      generationParams({
        modelId: 'm',
        defaultGenerationParameters: { temperature: null, maxTokens: 64 },
      }),
    ).toEqual({ maxTokens: 64 });
  });
});

describe('what reaches the endpoint', () => {
  it('translates heddle’s names into OpenAI’s', async () => {
    await new OpenAIProvider().chatCompletion(undefined, {
      model: 'gpt-4o',
      messages: MESSAGES,
      temperature: 0.2,
      maxTokens: 512,
      topP: 0.9,
    });

    expect(sent()).toMatchObject({ temperature: 0.2, max_tokens: 512, top_p: 0.9 });
  });

  it('sends nothing at all for a parameter the caller left out', async () => {
    await new OpenAIProvider().chatCompletion(undefined, {
      model: 'gpt-4o',
      messages: MESSAGES,
      temperature: 0,
    });

    const body = sent();
    // Present with the falsy value the caller asked for...
    expect(body.temperature).toBe(0);
    // ...and absent rather than `undefined` for the rest. Several
    // OpenAI-compatible endpoints reject a null-valued field they would have
    // defaulted happily.
    expect('max_tokens' in body).toBe(false);
    expect('top_p' in body).toBe(false);
    expect('response_format' in body).toBe(false);
  });

  it('asks for JSON in the shape this endpoint understands', async () => {
    await new OpenAIProvider().chatCompletion(undefined, {
      model: 'gpt-4o',
      messages: MESSAGES,
      responseFormat: 'json',
    });

    // Two values on `ChatRequest`, an object here: every provider can do JSON
    // and each does it differently, so the translation belongs at the vendor.
    expect(sent().response_format).toEqual({ type: 'json_object' });
  });

  it('leaves the request alone when the caller wants text', async () => {
    await new OpenAIProvider().chatCompletion(undefined, {
      model: 'gpt-4o',
      messages: MESSAGES,
      responseFormat: 'text',
    });

    expect('response_format' in sent()).toBe(false);
  });

  it('carries the same parameters on the streamed call', async () => {
    // The two paths have to be the same request or a spec's settings would
    // apply only when streaming happened to be off — which depends on the
    // deployment, not on the spec.
    create.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] };
      },
    });

    const stream = new OpenAIProvider().chatCompletionStream!(undefined, {
      model: 'gpt-4o',
      messages: MESSAGES,
      temperature: 0.2,
      maxTokens: 512,
    });
    for await (const _ of stream) void _;

    expect(sent()).toMatchObject({ temperature: 0.2, max_tokens: 512, stream: true });
  });
});

/** An agent node whose config carries whatever the case is about. */
function agentNode(generation: Record<string, unknown>): AgentNode {
  return {
    componentType: 'AgentNode',
    name: 'a',
    agent: {
      componentType: 'Agent',
      name: 'a',
      systemPrompt: 'be terse',
      llmConfig: {
        componentType: 'OpenAiConfig',
        modelId: 'gpt-4o',
        defaultGenerationParameters: generation,
      },
    },
  } as AgentNode;
}

describe('a spec that sets them', () => {
  it('sends an agent’s configured parameters with the request', async () => {
    // Buffered, because the streamed form of this request is covered above and
    // the mock can only be one shape at a time. What is under test is the
    // executor reading the spec, which both paths share.
    const executor = new AgentExecutor(
      agentNode({ temperature: 0.1, maxTokens: 128 }),
      { stream: false },
    );

    await executor.execute(undefined, new State({ text: 'hi' }));

    expect(sent()).toMatchObject({ temperature: 0.1, max_tokens: 128 });
  });

  it('fails when the flow is compiled, not part-way through a run', () => {
    // Beside the transform check in the same constructor, and for the same
    // reason: a spec that cannot produce a valid request should say so before
    // anything has been billed.
    expect(() => new AgentExecutor(agentNode({ maxTokens: 'lots' }), {})).toThrow(
      LLMError,
    );
  });
});
