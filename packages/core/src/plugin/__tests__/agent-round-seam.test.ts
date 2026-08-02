/**
 * The `agentRound` seam.
 *
 * The narrowest of the five, and deliberately: `proceed` or `reject` before a
 * round, `pass` or `fail` after one, and nothing that rewrites anything. A round
 * is one model call plus the tool calls it asked for, and the two seams inside
 * it already own what is sent and what runs — so what is left for this one is
 * the thing neither of them can say, which is that there should not be another
 * round.
 *
 * That is the whole use. `MAX_TOOL_ROUNDS` is an engine constant an operator
 * cannot move, so an agent looping on tools spends ten rounds of somebody's
 * money before heddle stops it. This is where a lower ceiling hangs.
 *
 * The asymmetry to pin: `before` is asked about every round, `after` only about
 * a round that ran tool calls. Stopping the next round is all the `after` half
 * can do, and a round that ended in an answer is not about to become one.
 */
import { describe, it, expect } from 'vitest';
import { AgentExecutor } from '../../node/agent.js';
import { MiddlewareChain } from '../middleware.js';
import { PluginRegistry } from '../registry.js';
import { isSeam } from '../seams.js';
import { State } from '../../state/state.js';
import type { AgentNode } from '../../spec/types.js';
import type { Event } from '../../runner/events.js';
import type { Provider } from '../../llm/types.js';
import type { Dependencies } from '../../node/types.js';
import type {
  AfterVerdict,
  BeforeVerdict,
  PluginMiddlewareDef,
} from '../../index.js';

/**
 * A provider that asks for one tool call a round, as many times as told, and
 * then answers.
 *
 * `loopingProvider(2)` is three model calls: two rounds that ran a tool and a
 * third that produced the answer.
 */
function loopingProvider(toolRounds: number): {
  provider: Provider;
  calls: () => number;
} {
  let calls = 0;

  return {
    calls: () => calls,
    provider: {
      chatCompletion: async () => {
        calls++;
        if (calls > toolRounds) {
          return { content: 'done', finish_reason: 'stop' };
        }
        return {
          content: '',
          finish_reason: 'tool_calls',
          tool_calls: [
            { id: `call_${calls}`, name: 'shell', arguments: '{"cmd":"ls"}' },
          ],
        };
      },
    },
  };
}

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

const chainOf = (def: PluginMiddlewareDef): MiddlewareChain =>
  MiddlewareChain.build(
    PluginRegistry.fromPlugins([{ name: 'p', version: '1.0.0', middleware: [def] }]),
    {},
  );

function agentWith(
  chain: MiddlewareChain | undefined,
  provider: Provider,
): { execute: () => Promise<State>; events: Event[] } {
  const events: Event[] = [];
  const deps: Dependencies = {
    eventHandler: (e) => events.push(e),
    middleware: chain,
    createProvider: () => provider,
    toolRegistry: {
      lookup: (name) =>
        name === 'shell'
          ? {
              name: 'shell',
              description: '',
              origin: 'test',
              impl: {
                kind: 'plugin',
                plugin: 'test',
                call: async () => ({ output: { ok: true }, stderr: '' }),
              },
            }
          : undefined,
      all: () => [],
    },
  };

  const node = {
    name: 'assistant',
    componentType: 'AgentNode',
    agent: {
      name: 'assistant',
      systemPrompt: 'do the thing',
      llmConfig: { componentType: 'OpenAiConfig', modelId: 'gpt-4o', name: 'llm' },
      tools: [{ name: 'shell', description: 'run a command' }],
      transforms: [],
    },
  } as unknown as AgentNode;

  const executor = new AgentExecutor(node, deps);
  return { execute: () => executor.execute(undefined, new State({})), events };
}

describe('before a round', () => {
  it('is asked about every round, the one that answers included', async () => {
    const rounds: number[] = [];
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before'] }, {
        before: ({ input }: { input: { round: number } }) => {
          rounds.push(input.round);
          return { action: 'proceed' };
        },
      })),
      loopingProvider(2).provider,
    );

    await agent.execute();

    // Counted from 1, because the number is what a policy caps and the third
    // round should not be numbered 2.
    expect(rounds).toEqual([1, 2, 3]);
  });

  it('is told the round number and the ceiling it is tightening', async () => {
    let seen: unknown;
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before'] }, {
        before: ({ input }: { input: Record<string, unknown> }) => {
          seen ??= input;
          return { action: 'proceed' };
        },
      })),
      loopingProvider(1).provider,
    );

    await agent.execute();

    // `maxRounds` is heddle's own `MAX_TOOL_ROUNDS`. A policy that wants a
    // fraction of it would otherwise write 10 down and drift when it moves.
    expect(seen).toEqual({ round: 1, maxRounds: 10 });
  });

  it('refuses the first round before any model call is made', async () => {
    const { provider, calls } = loopingProvider(2);
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before'] }, {
        before: () => ({ action: 'reject', reason: 'over the daily budget' }),
      })),
      provider,
    );

    await expect(agent.execute()).rejects.toThrow(
      /Policy.*before round 1.*over the daily budget/s,
    );
    expect(calls()).toBe(0);
  });

  it('caps the rounds an agent may spend, which is what it is for', async () => {
    const { provider, calls } = loopingProvider(9);
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before'] }, {
        before: ({ input }: { input: { round: number } }) =>
          input.round > 3
            ? { action: 'reject', reason: 'three rounds is the budget' }
            : { action: 'proceed' },
      })),
      provider,
    );

    await expect(agent.execute()).rejects.toThrow(/three rounds is the budget/);
    // Three, where the engine's own ceiling would have spent ten.
    expect(calls()).toBe(3);
  });
});

describe('after a round', () => {
  it('is asked only about a round that ran tool calls', async () => {
    const rounds: number[] = [];
    const agent = agentWith(
      chainOf(policy({ agentRound: ['after'] }, {
        after: ({ outcome }: { outcome: { value: { round: number } } }) => {
          rounds.push(outcome.value.round);
          return { action: 'pass' };
        },
      })),
      loopingProvider(2).provider,
    );

    await agent.execute();

    expect(rounds).toEqual([1, 2]);
  });

  it('is told what the round produced', async () => {
    const seen: unknown[] = [];
    const agent = agentWith(
      chainOf(policy({ agentRound: ['after'] }, {
        after: ({ outcome }: { outcome: unknown }) => {
          seen.push(outcome);
          return { action: 'pass' };
        },
      })),
      loopingProvider(1).provider,
    );

    await agent.execute();

    expect(seen).toEqual([
      { ok: true, value: { round: 1, toolCalls: ['shell'] } },
    ]);
  });

  it('ends the run with a stated reason, naming the round', async () => {
    const { provider, calls } = loopingProvider(9);
    const agent = agentWith(
      chainOf(policy({ agentRound: ['after'] }, {
        after: () => ({ action: 'fail', reason: 'the agent is going in circles' }),
      })),
      provider,
    );

    await expect(agent.execute()).rejects.toThrow(
      /Policy.*after round 1.*going in circles/s,
    );
    expect(calls()).toBe(1);
  });
});

describe('a round that produced the answer', () => {
  it('is asked before and not after, becoming no further round', async () => {
    const befores: number[] = [];
    const afters: number[] = [];
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before', 'after'] }, {
        before: ({ input }: { input: { round: number } }) => {
          befores.push(input.round);
          return { action: 'proceed' };
        },
        after: ({ outcome }: { outcome: { value: { round: number } } }) => {
          afters.push(outcome.value.round);
          return { action: 'pass' };
        },
      })),
      loopingProvider(1).provider,
    );

    await agent.execute();

    // Round 1 ran a tool, round 2 answered. `fail` is all the after half can
    // say and there is nothing left to stop once the agent is finishing — what
    // the answer itself is worth is `node`'s to decide, and that seam is shown
    // the whole output rather than a list of tool names.
    expect(befores).toEqual([1, 2]);
    expect(afters).toEqual([1]);
  });

  it('reaches no after half at all when the agent answers straight away', async () => {
    let afters = 0;
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before', 'after'] }, {
        before: () => ({ action: 'proceed' }),
        after: () => {
          afters++;
          return { action: 'pass' };
        },
      })),
      loopingProvider(0).provider,
    );

    await agent.execute();

    expect(afters).toBe(0);
  });
});

describe('what the seam will not admit', () => {
  it('refuses a before verdict that would rewrite the round', async () => {
    // `modify` and `replace` are admitted where a middleware hands back input
    // or an answer. There is nothing of the kind here: a round is not a value,
    // and a guard that could supply one would be a different seam.
    const agent = agentWith(
      chainOf(policy({ agentRound: ['before'] }, {
        before: () =>
          ({ action: 'modify', input: { round: 1 } }) as unknown as BeforeVerdict,
      })),
      loopingProvider(2).provider,
    );

    await expect(agent.execute()).rejects.toThrow(/admits: proceed, reject/);
  });

  it('refuses an after verdict that would retry the round', async () => {
    // The tool calls of this round are already in the conversation, so running
    // it again is not re-entering a clean state — `toolCall`'s reason, one
    // level out.
    const agent = agentWith(
      chainOf(policy({ agentRound: ['after'] }, {
        after: () => ({ action: 'retry' }) as unknown as AfterVerdict,
      })),
      loopingProvider(2).provider,
    );

    await expect(agent.execute()).rejects.toThrow(/admits: pass, fail/);
  });
});

describe('what the seam costs when nobody uses it', () => {
  it('runs an agent unchanged with no chain at all', async () => {
    const { provider, calls } = loopingProvider(2);

    const state = await agentWith(undefined, provider).execute();

    expect(state.get('result')).toBe('done');
    expect(calls()).toBe(3);
  });

  it('leaves the agent exactly as it was on proceed and pass', async () => {
    const baseline = await agentWith(undefined, loopingProvider(2).provider).execute();

    const { provider, calls } = loopingProvider(2);
    const guarded = agentWith(
      chainOf(policy({ agentRound: ['before', 'after'] }, {
        before: () => ({ action: 'proceed' }),
        after: () => ({ action: 'pass' }),
      })),
      provider,
    );

    expect((await guarded.execute()).toData()).toEqual(baseline.toData());
    expect(calls()).toBe(3);
  });

  it('asks neither half when nothing subscribes to it', async () => {
    let asked = 0;
    const agent = agentWith(
      // Subscribed to a seam this node never reaches: `nodeError` is the
      // runner's, so both of these handlers stay unasked.
      chainOf(policy({ nodeError: ['after'] }, {
        after: () => {
          asked++;
          return { action: 'pass' };
        },
      })),
      loopingProvider(2).provider,
    );

    await agent.execute();

    expect(asked).toBe(0);
  });

  it('asks only the half that was subscribed', async () => {
    let befores = 0;
    let afters = 0;
    const agent = agentWith(
      chainOf(policy({ agentRound: ['after'] }, {
        before: () => {
          befores++;
          return { action: 'proceed' };
        },
        after: () => {
          afters++;
          return { action: 'pass' };
        },
      })),
      loopingProvider(2).provider,
    );

    await agent.execute();

    // The call site asks `hasBefore` first, which is what keeps an `after`-only
    // policy from costing a round trip ahead of every model call.
    expect(befores).toBe(0);
    expect(afters).toBe(2);
  });
});

describe('the table this seam completed', () => {
  it('no longer knows "toolResult" at all', () => {
    // Reserved until `toolCall` grew an `after` half, which sees the call, its
    // arguments, its id and the result. A seam shown the result without the
    // call that asked for it is strictly less, so the name was dropped rather
    // than built, and a manifest naming it is refused for not being a seam.
    expect(isSeam('toolResult')).toBe(false);
  });
});
