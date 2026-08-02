/**
 * The `toolCall` seam — the first `before` half heddle consults.
 *
 * Every seam before this one reported: `nodeError` is handed an outcome and
 * decides what to make of it. This one is asked *first*, which is what makes an
 * approval gate expressible, and it brings a constraint no `after` hook has.
 *
 * **A tool call must be answered.** A provider refuses a request whose assistant
 * message asked for a tool call that no tool message answers, so a middleware
 * that refuses one cannot simply skip it — the refusal has to be a reply. That
 * is not a heddle preference; it is the wire format, and it is why `reject`
 * carries a reason the model can read rather than being a way to abandon a turn.
 * Most of what follows is that invariant approached from different sides.
 */
import { describe, it, expect } from 'vitest';
import type { Message, Provider } from '../../llm/types.js';
import type { BeforeVerdict, PluginMiddlewareDef } from '../../index.js';
import { agentWith, chainOf } from './helpers/seams.js';

/** A provider that asks for one tool call, then answers with what it got back. */
function askingProvider(toolName = 'shell'): {
  provider: Provider;
  seen: () => Message[];
} {
  let round = 0;
  let captured: Message[] = [];

  return {
    seen: () => captured,
    provider: {
      chatCompletion: async (_signal, request) => {
        captured = request.messages;
        round++;
        if (round === 1) {
          return {
            content: '',
            finish_reason: 'tool_calls',
            tool_calls: [
              { id: 'call_1', name: toolName, arguments: '{"cmd":"rm -rf /"}' },
            ],
          };
        }
        return { content: 'done', finish_reason: 'stop' };
      },
    },
  };
}

function gate(verdict: BeforeVerdict): PluginMiddlewareDef {
  return {
    componentType: 'Gate',
    seams: { toolCall: ['before'] },
    createMiddleware: () => ({
      before: () => verdict,
      after: () => ({ action: 'pass' }),
    }),
  };
}

/** The tool messages an agent produced, in order. */
const toolReplies = (seen: Message[]): Message[] =>
  seen.filter((m) => m.role === 'tool');

describe('a refused tool call', () => {
  it('is still answered, so the conversation stays well-formed', async () => {
    const { provider, seen } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'reject', reason: 'destructive command' })),
      provider,
    );

    await agent.execute();

    // The assistant asked for `call_1`; something has to reply to `call_1`, or
    // the next request is malformed and the provider refuses it.
    const replies = toolReplies(seen());
    expect(replies).toHaveLength(1);
    expect(replies[0].tool_call_id).toBe('call_1');
    expect(replies[0].content).toContain('destructive command');
  });

  it('does not run the tool', async () => {
    let ran = 0;
    const { provider } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'reject', reason: 'no' })),
      provider,
      () => {
        ran++;
        return {};
      },
    );

    await agent.execute();

    expect(ran).toBe(0);
  });

  it('says who refused it and why', async () => {
    const { provider } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'reject', reason: 'needs approval' })),
      provider,
    );

    await agent.execute();

    const warning = agent.events.find((e) => e.type === 'warning');
    expect(warning?.message).toContain('Gate');
    expect(warning?.message).toContain('needs approval');
  });

  it('is reported as a result rather than as the tool failing', async () => {
    const { provider } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'reject', reason: 'policy' })),
      provider,
    );

    await agent.execute();

    // Nothing broke. A client rendering this as an error would be saying the
    // tool was tried and went wrong, which is not what happened.
    const result = agent.events.find((e) => e.type === 'tool_result');
    expect(result?.error).toBeUndefined();
    expect(result?.toolResult).toMatchObject({ refused: true });
  });

  it('emits no tool_call event, because none was made', async () => {
    const { provider } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'reject', reason: 'policy' })),
      provider,
    );

    await agent.execute();

    expect(agent.events.some((e) => e.type === 'tool_call')).toBe(false);
  });
});

describe('the other three verdicts', () => {
  it('proceeds untouched by default', async () => {
    let args: Record<string, unknown> | undefined;
    const { provider, seen } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'proceed' })),
      provider,
      () => {
        args = { ran: true };
        return { ok: true };
      },
    );

    await agent.execute();

    expect(args).toEqual({ ran: true });
    expect(toolReplies(seen())[0].content).toBe('{"ok":true}');
  });

  it('runs the tool with the arguments a middleware substituted', async () => {
    let received: Record<string, unknown> | undefined;
    const captured = agentWith(
      chainOf(gate({ action: 'modify', input: { cmd: 'ls' } })),
      askingProvider().provider,
      () => {
        received = { seen: true };
        return { ok: true };
      },
    );
    await captured.execute();

    expect(received).toEqual({ seen: true });
  });

  it('reports the substituted arguments, not the ones the model wrote', async () => {
    const { provider } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'modify', input: { cmd: 'ls' } })),
      provider,
    );

    await agent.execute();

    // What a client sees has to be what actually ran, or an audit log records a
    // command nobody executed.
    const call = agent.events.find((e) => e.type === 'tool_call');
    expect(call?.toolArgs).toEqual({ cmd: 'ls' });
  });

  it('supplies a result without running the tool', async () => {
    let ran = 0;
    const { provider, seen } = askingProvider();
    const agent = agentWith(
      chainOf(gate({ action: 'replace', value: { cached: true } })),
      provider,
      () => {
        ran++;
        return {};
      },
    );

    await agent.execute();

    expect(ran).toBe(0);
    expect(toolReplies(seen())[0].content).toBe('{"cached":true}');
    expect(toolReplies(seen())[0].tool_call_id).toBe('call_1');
  });
});

describe('a chain of gates', () => {
  it('lets a modification reach the next middleware', async () => {
    // `modify` does not settle anything, so the walk continues — which is what
    // lets a redactor rewrite the arguments and an approval gate then see what
    // would actually run rather than what the model first asked for.
    const seenBySecond: Record<string, unknown>[] = [];
    const chain = chainOf(
      // Declared first, so consulted *last* — the chain walks in reverse
      // load order, as the operator's last --plugin wins first.
      {
        componentType: 'Gate',
        seams: { toolCall: ['before'] },
        createMiddleware: () => ({
          before: ({ input }) => {
            seenBySecond.push(input);
            return { action: 'proceed' };
          },
          after: () => ({ action: 'pass' }),
        }),
      },
      {
        componentType: 'Redactor',
        seams: { toolCall: ['before'] },
        createMiddleware: () => ({
          before: () => ({ action: 'modify', input: { cmd: 'ls' } }),
          after: () => ({ action: 'pass' }),
        }),
      },
    );

    const agent = agentWith(chain, askingProvider().provider);
    await agent.execute();

    expect(seenBySecond).toEqual([{ cmd: 'ls' }]);
  });

  it('stops at the first refusal', async () => {
    let asked = 0;
    const chain = chainOf(
      {
        componentType: 'Never',
        seams: { toolCall: ['before'] },
        createMiddleware: () => ({
          before: () => {
            asked++;
            return { action: 'proceed' };
          },
          after: () => ({ action: 'pass' }),
        }),
      },
      {
        componentType: 'Gate',
        seams: { toolCall: ['before'] },
        createMiddleware: () => ({
          before: () => ({ action: 'reject', reason: 'no' }),
          after: () => ({ action: 'pass' }),
        }),
      },
    );

    const agent = agentWith(chain, askingProvider().provider);
    await agent.execute();

    // Load order reversed, so `Gate` is consulted first and refuses; `Never`
    // is never reached.
    expect(asked).toBe(0);
  });
});

describe('what the seam costs when nobody uses it', () => {
  it('consults nothing when no middleware is installed', async () => {
    const { provider, seen } = askingProvider();
    const agent = agentWith(undefined, provider);

    await agent.execute();

    expect(toolReplies(seen())[0].content).toBe('{"ok":true}');
  });

  it('consults nothing when no middleware subscribes to the before half', async () => {
    // Subscribed to `after` only. The call site checks `hasBefore`, so this
    // costs no round trip per tool call — which matters more here than at
    // `nodeError`, since this runs on every call of every round.
    let asked = 0;
    const chain = chainOf({
      componentType: 'AfterOnly',
      seams: { toolCall: ['after'] },
      createMiddleware: () => ({
        before: () => {
          asked++;
          return { action: 'proceed' };
        },
        after: () => ({ action: 'pass' }),
      }),
    });

    const agent = agentWith(chain, askingProvider().provider);
    await agent.execute();

    expect(asked).toBe(0);
  });
});

describe('what the seam will not admit', () => {
  it('refuses a verdict this seam does not have', async () => {
    // `retry` is admitted at `nodeError` and not here: by the time a tool call
    // is decided, the assistant message that asked for it is already in the
    // conversation, so re-issuing it is not re-entering a clean state.
    const chain = chainOf({
      componentType: 'Confused',
      seams: { toolCall: ['before'] },
      createMiddleware: () => ({
        before: () => ({ action: 'retry' }) as unknown as BeforeVerdict,
        after: () => ({ action: 'pass' }),
      }),
    });

    const agent = agentWith(chain, askingProvider().provider);

    await expect(agent.execute()).rejects.toThrow();
  });

  it('refuses a middleware that hooks before and serves no handler', async () => {
    const chain = chainOf({
      componentType: 'Half',
      seams: { toolCall: ['before'] },
      createMiddleware: () => ({ after: () => ({ action: 'pass' }) }),
    });

    const agent = agentWith(chain, askingProvider().provider);

    await expect(agent.execute()).rejects.toThrow(/no before handler/);
  });
});

describe('the after half, which the seam also declares', () => {
  const afterGate = (verdict: Record<string, unknown>): PluginMiddlewareDef => ({
    componentType: 'Auditor',
    seams: { toolCall: ['after'] },
    createMiddleware: () => ({
      after: () => verdict as never,
    }),
  });

  it('is consulted when the tool returned', async () => {
    let saw: unknown;
    const chain = chainOf({
      componentType: 'Auditor',
      seams: { toolCall: ['after'] },
      createMiddleware: () => ({
        after: ({ outcome }) => {
          saw = outcome;
          return { action: 'pass' };
        },
      }),
    });

    const agent = agentWith(chain, askingProvider().provider);
    await agent.execute();

    expect(saw).toEqual({ ok: true, value: { ok: true } });
  });

  it('is consulted when the tool threw', async () => {
    let saw: { ok: boolean } | undefined;
    const chain = chainOf({
      componentType: 'Auditor',
      seams: { toolCall: ['after'] },
      createMiddleware: () => ({
        after: ({ outcome }) => {
          saw = outcome;
          return { action: 'pass' };
        },
      }),
    });

    const agent = agentWith(chain, askingProvider().provider, () => {
      throw new Error('tool blew up');
    });
    await agent.execute();

    expect(saw?.ok).toBe(false);
  });

  it('can substitute a result the tool did not produce', async () => {
    const { provider, seen } = askingProvider();
    const agent = agentWith(chainOf(afterGate({ action: 'replace', value: { tidied: true } })), provider);

    await agent.execute();

    expect(toolReplies(seen())[0].content).toBe('{"tidied":true}');
    expect(toolReplies(seen())[0].tool_call_id).toBe('call_1');
  });

  it('can fail the run', async () => {
    const agent = agentWith(
      chainOf(afterGate({ action: 'fail', reason: 'output contained a secret' })),
      askingProvider().provider,
    );

    await expect(agent.execute()).rejects.toThrow(/output contained a secret/);
  });

  it('is not consulted when nothing subscribes to it', async () => {
    let asked = 0;
    const chain = chainOf({
      componentType: 'BeforeOnly',
      seams: { toolCall: ['before'] },
      createMiddleware: () => ({
        before: () => ({ action: 'proceed' }),
        after: () => {
          asked++;
          return { action: 'pass' };
        },
      }),
    });

    const agent = agentWith(chain, askingProvider().provider);
    await agent.execute();

    expect(asked).toBe(0);
  });
});
