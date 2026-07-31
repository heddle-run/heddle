/**
 * The `modelCall` seam.
 *
 * The seam that admits `retry` where `toolCall` does not, and the difference is
 * what has already been said. A failed tool call leaves an assistant message in
 * the conversation asking for it, so re-issuing is not re-entering a clean
 * state. A failed model call has changed nothing, so it is — which makes this
 * the seam a 429 policy hangs off, and that is the most asked-for middleware
 * there is.
 *
 * It is also the only place a middleware hands back something heddle then
 * *sends somewhere*, so `modify` is checked harder than any other verdict.
 */
import { describe, it, expect } from 'vitest';
import { completeChat } from '../../node/agent.js';
import { MiddlewareChain } from '../middleware.js';
import { PluginRegistry } from '../registry.js';
import type { Event } from '../../runner/events.js';
import type { ChatRequest, ChatResponse, Provider } from '../../llm/types.js';
import type { PluginMiddlewareDef } from '../../index.js';

const REQUEST: ChatRequest = {
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'the question' }],
};

/** A provider that records what it was asked, and answers however told. */
function recording(answers: Array<ChatResponse | Error>): {
  provider: Provider;
  asked: ChatRequest[];
} {
  const asked: ChatRequest[] = [];
  let call = 0;

  return {
    asked,
    provider: {
      chatCompletion: async (_signal, request) => {
        asked.push(request);
        const answer = answers[Math.min(call++, answers.length - 1)];
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const ANSWER: ChatResponse = { content: 'the answer', finish_reason: 'stop' };

const chainOf = (...defs: PluginMiddlewareDef[]): MiddlewareChain =>
  MiddlewareChain.build(
    PluginRegistry.fromPlugins([{ name: 'p', version: '1.0.0', middleware: defs }]),
    {},
  );

function policy(
  seams: PluginMiddlewareDef['seams'],
  impl: Record<string, unknown>,
): PluginMiddlewareDef {
  return {
    componentType: 'Policy',
    seams,
    createMiddleware: () => impl as never,
  };
}

const run = (
  provider: Provider,
  middleware?: MiddlewareChain,
  events: Event[] = [],
): Promise<ChatResponse> =>
  completeChat(provider, undefined, REQUEST, {
    nodeName: 'assistant',
    nodeType: 'AgentNode',
    middleware,
    eventHandler: (e) => events.push(e),
    allowStream: false,
  });

describe('before the call', () => {
  it('sends the request untouched by default', async () => {
    const { provider, asked } = recording([ANSWER]);
    await run(provider, chainOf(policy({ modelCall: ['before'] }, {
      before: () => ({ action: 'proceed' }),
    })));

    expect(asked[0].messages[0].content).toBe('the question');
  });

  it('sends a request a middleware edited', async () => {
    const { provider, asked } = recording([ANSWER]);
    await run(provider, chainOf(policy({ modelCall: ['before'] }, {
      before: ({ input }) => ({
        action: 'modify',
        input: { ...input, temperature: 0, model: 'gpt-4o-mini' },
      }),
    })));

    expect(asked[0].temperature).toBe(0);
    expect(asked[0].model).toBe('gpt-4o-mini');
    // Untouched fields keep what the middleware was shown: a returned object is
    // an edit, not a replacement.
    expect(asked[0].messages[0].content).toBe('the question');
  });

  it('answers without calling the model at all', async () => {
    // The cache hit, and the reason `replace` is admitted *before* the call.
    const { provider, asked } = recording([ANSWER]);
    const events: Event[] = [];
    const answer = await run(
      provider,
      chainOf(policy({ modelCall: ['before'] }, {
        before: () => ({
          action: 'replace',
          value: { content: 'from the cache', finish_reason: 'stop' },
        }),
      })),
      events,
    );

    expect(asked).toEqual([]);
    expect(answer.content).toBe('from the cache');
    expect(events.find((e) => e.type === 'warning')?.message).toContain('Policy');
  });

  it('refuses the call, naming the middleware and the reason', async () => {
    const { provider, asked } = recording([ANSWER]);
    await expect(
      run(provider, chainOf(policy({ modelCall: ['before'] }, {
        before: () => ({ action: 'reject', reason: 'over the daily budget' }),
      }))),
    ).rejects.toThrow(/Policy.*over the daily budget/s);

    expect(asked).toEqual([]);
  });
});

describe('what a middleware may not send', () => {
  const modifying = (input: unknown) =>
    run(
      recording([ANSWER]).provider,
      chainOf(policy({ modelCall: ['before'] }, {
        before: () => ({ action: 'modify', input }),
      })),
    );

  it('refuses messages that are not an array', async () => {
    await expect(modifying({ messages: 'hello' })).rejects.toThrow(/not an array/);
  });

  it('refuses a message with no content', async () => {
    await expect(
      modifying({ messages: [{ role: 'user' }] }),
    ).rejects.toThrow(/content/);
  });

  it('refuses a message with a role the API does not have', async () => {
    await expect(
      modifying({ messages: [{ role: 'wizard', content: 'x' }] }),
    ).rejects.toThrow(/expected one of/);
  });

  it('refuses a temperature that is not a number', async () => {
    await expect(modifying({ temperature: 'hot' })).rejects.toThrow(/not a number/);
  });

  it('refuses an empty model name', async () => {
    await expect(modifying({ model: '' })).rejects.toThrow(/not a name/);
  });
});

describe('after the call', () => {
  it('retries a failure, which is what this seam is for', async () => {
    const { provider, asked } = recording([
      new Error('429 Too Many Requests'),
      ANSWER,
    ]);
    const events: Event[] = [];

    const answer = await run(
      provider,
      chainOf(policy({ modelCall: ['after'] }, {
        after: ({ outcome }) =>
          outcome.ok || !/429/.test(outcome.error.message)
            ? { action: 'pass' }
            : { action: 'retry' },
      })),
      events,
    );

    expect(asked).toHaveLength(2);
    expect(answer.content).toBe('the answer');
    expect(events.find((e) => e.type === 'warning')?.message).toContain('retrying');
  });

  it('stops retrying at the ceiling, which a middleware cannot raise', async () => {
    const { provider, asked } = recording([new Error('429')]);

    await expect(
      run(provider, chainOf(policy({ modelCall: ['after'] }, {
        after: () => ({ action: 'retry' }),
      }))),
    ).rejects.toThrow(/429/);

    // Three attempts, then the outcome stands. A ceiling a middleware can raise
    // is not a ceiling.
    expect(asked).toHaveLength(3);
  });

  it('substitutes an answer for one that failed', async () => {
    const { provider } = recording([new Error('the model is down')]);

    const answer = await run(
      provider,
      chainOf(policy({ modelCall: ['after'] }, {
        after: () => ({
          action: 'replace',
          value: { content: 'sorry, try later', finish_reason: 'stop' },
        }),
      })),
    );

    expect(answer.content).toBe('sorry, try later');
  });

  it('ends the call with a stated reason', async () => {
    const { provider } = recording([ANSWER]);

    await expect(
      run(provider, chainOf(policy({ modelCall: ['after'] }, {
        after: () => ({ action: 'fail', reason: 'the answer leaked a secret' }),
      }))),
    ).rejects.toThrow(/leaked a secret/);
  });

  it('lets the outcome stand on pass', async () => {
    const { provider } = recording([ANSWER]);

    const answer = await run(
      provider,
      chainOf(policy({ modelCall: ['after'] }, {
        after: () => ({ action: 'pass' }),
      })),
    );

    expect(answer.content).toBe('the answer');
  });
});

describe('what the seam costs when nobody uses it', () => {
  it('behaves exactly as before with no chain at all', async () => {
    const { provider, asked } = recording([ANSWER]);
    const answer = await run(provider);

    expect(asked).toHaveLength(1);
    expect(answer).toEqual(ANSWER);
  });

  it('still surfaces a failure with no chain', async () => {
    const { provider } = recording([new Error('the model is down')]);
    await expect(run(provider)).rejects.toThrow(/the model is down/);
  });

  it('asks neither half when nothing subscribes to it', async () => {
    let asked = 0;
    const chain = chainOf(policy({ toolCall: ['before', 'after'] }, {
      before: () => {
        asked++;
        return { action: 'proceed' };
      },
      after: () => {
        asked++;
        return { action: 'pass' };
      },
    }));

    await run(recording([ANSWER]).provider, chain);

    expect(asked).toBe(0);
  });
});
