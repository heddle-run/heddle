/**
 * The `node` seam.
 *
 * The widest of the five: consulted around every node of every flow, not only
 * around a failure, a tool call or a model call. That is what makes it the one a
 * cache, a dry run or an audit hangs off, and it is also why the cost when
 * nobody subscribes matters more here than anywhere else.
 *
 * Two seams sit at the same position and the nesting is the thing to pin.
 * `node` wraps *an execution*; `nodeError` sits inside it and owns retries. So a
 * retried attempt gets a second `before` and no `after`, and a settled one gets
 * exactly one `after` whether it succeeded or failed.
 */
import { describe, it, expect } from 'vitest';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { Event } from '../../runner/events.js';
import { State } from '../../state/state.js';
import { MiddlewareChain, MiddlewareError } from '../middleware.js';
import type { CompiledGraph, CompiledNode } from '../../graph/types.js';
import { chainOf, policy } from './helpers/seams.js';

/**
 * start → work → done, where `work` fails as many times as it is told to.
 *
 * Three nodes rather than one, because "every node" is the claim under test and
 * a single-node graph cannot tell it from "the node".
 */
function graphOf(spec: { failFor?: number; branchOut?: boolean } = {}): {
  graph: CompiledGraph;
  ran: () => string[];
} {
  const ran: string[] = [];
  let attempts = 0;

  const node = (
    name: string,
    type: string,
    execute: (input: State) => State,
    edges: Array<{ fromNode: string; fromBranch?: string; toNode: string }>,
    branch = '',
  ): CompiledNode =>
    ({
      name,
      type,
      specNode: { componentType: type, name } as never,
      executor: {
        execute: async (_s: AbortSignal | undefined, input: State) => {
          ran.push(name);
          return execute(input);
        },
        branch: () => branch,
      },
      edges,
      inputMappings: new Map(),
    }) as CompiledNode;

  const work = node(
    'work',
    'ToolNode',
    (input) => {
      attempts++;
      if (attempts <= (spec.failFor ?? 0)) {
        throw new Error(`work failed on attempt ${attempts}`);
      }
      return input.merge(new State({ worked: true, seen: input.get('seen') }));
    },
    spec.branchOut
      ? [{ fromNode: 'work', fromBranch: 'onward', toNode: 'done' }]
      : [{ fromNode: 'work', toNode: 'done' }],
    spec.branchOut ? 'onward' : '',
  );

  const nodes = new Map<string, CompiledNode>([
    [
      'start',
      node('start', 'StartNode', (input) => input, [
        { fromNode: 'start', toNode: 'work' },
      ]),
    ],
    ['work', work],
    ['done', node('done', 'EndNode', (input) => input, [])],
  ]);

  const graph = {
    name: 'three',
    start: 'start',
    getNode: (name: string) => nodes.get(name),
    nextNode: (current: CompiledNode, wanted: string) => {
      let fallback: CompiledNode | undefined;
      for (const edge of current.edges) {
        const edgeBranch = edge.fromBranch ?? '';
        if (wanted && edgeBranch === wanted) return nodes.get(edge.toNode);
        if (!edgeBranch && !fallback) fallback = nodes.get(edge.toNode);
      }
      return fallback;
    },
  } as unknown as CompiledGraph;

  return { graph, ran: () => ran };
}

async function run(
  graph: CompiledGraph,
  chain?: MiddlewareChain,
  overrides: Partial<typeof DEFAULT_RUNNER_OPTIONS> = {},
): Promise<{ state?: State; error?: Error; events: Event[] }> {
  const events: Event[] = [];
  const runner = new Runner(graph, {
    ...DEFAULT_RUNNER_OPTIONS,
    ...overrides,
    middleware: chain,
    eventHandler: (e) => events.push(e),
  });

  try {
    return { state: await runner.run(undefined, { seen: 'input' }), events };
  } catch (err) {
    return { error: err as Error, events };
  }
}

const warnings = (events: Event[]): string[] =>
  events
    .filter((e): e is Event & { message: string } => e.type === 'warning')
    .map((e) => e.message);

describe('before a node runs', () => {
  it('is asked about every node, not only the interesting one', async () => {
    const asked: string[] = [];
    const { graph } = graphOf();

    await run(
      graph,
      chainOf(policy({ node: ['before'] }, {
        before: ({ subject }: { subject: { nodeName?: string } }) => {
          asked.push(subject.nodeName ?? '');
          return { action: 'proceed' };
        },
      })),
    );

    expect(asked).toEqual(['start', 'work', 'done']);
  });

  it('carries the node type, so a policy can tell a start from an agent', async () => {
    const types: string[] = [];
    const { graph } = graphOf();

    await run(
      graph,
      chainOf(policy({ node: ['before'] }, {
        before: ({ subject }: { subject: { nodeType?: string } }) => {
          types.push(subject.nodeType ?? '');
          return { action: 'proceed' };
        },
      })),
    );

    expect(types).toEqual(['StartNode', 'ToolNode', 'EndNode']);
  });

  it('runs the node with an input a middleware edited', async () => {
    const { graph } = graphOf();

    const { state } = await run(
      graph,
      chainOf(policy({ node: ['before'] }, {
        before: ({ subject, input }: {
          subject: { nodeName?: string };
          input: Record<string, unknown>;
        }) =>
          subject.nodeName === 'work'
            ? { action: 'modify', input: { ...input, seen: 'redacted' } }
            : { action: 'proceed' },
      })),
    );

    expect(state?.get('seen')).toBe('redacted');
  });

  it('answers for a node without running it, which is the cache hit', async () => {
    const { graph, ran } = graphOf();

    const { state, events } = await run(
      graph,
      chainOf(policy({ node: ['before'] }, {
        before: ({ subject }: { subject: { nodeName?: string } }) =>
          subject.nodeName === 'work'
            ? { action: 'replace', value: { worked: 'from the cache' } }
            : { action: 'proceed' },
      })),
    );

    expect(ran()).toEqual(['start', 'done']);
    expect(state?.get('worked')).toBe('from the cache');
    expect(warnings(events).join()).toMatch(/instead of letting it run/);
  });

  it('refuses a node outright, naming the middleware and the reason', async () => {
    const { graph, ran } = graphOf();

    const { error } = await run(
      graph,
      chainOf(policy({ node: ['before'] }, {
        before: ({ subject }: { subject: { nodeName?: string } }) =>
          subject.nodeName === 'work'
            ? { action: 'reject', reason: 'this deployment runs no tools' }
            : { action: 'proceed' },
      })),
    );

    expect(error?.message).toMatch(/Policy.*runs no tools/s);
    expect(error?.message).toMatch(/not a fault in the document/);
    expect(ran()).toEqual(['start']);
  });
});

describe('after a node runs', () => {
  it('sees what it produced', async () => {
    const seen: unknown[] = [];
    const { graph } = graphOf();

    await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: ({ subject, outcome }: {
          subject: { nodeName?: string };
          outcome: { ok: boolean; value?: unknown };
        }) => {
          if (subject.nodeName === 'work') seen.push(outcome);
          return { action: 'pass' };
        },
      })),
    );

    expect(seen).toEqual([{ ok: true, value: { seen: 'input', worked: true } }]);
  });

  it('replaces an output the node did produce, and says so', async () => {
    const { graph } = graphOf();

    const { state, events } = await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: ({ subject }: { subject: { nodeName?: string } }) =>
          subject.nodeName === 'work'
            ? { action: 'replace', value: { worked: 'rewritten' } }
            : { action: 'pass' },
      })),
    );

    expect(state?.get('worked')).toBe('rewritten');
    expect(warnings(events).join()).toMatch(/replaced what "work" produced/);
  });

  it('ends the run with a stated reason', async () => {
    const { graph } = graphOf();

    const { error } = await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: ({ subject }: { subject: { nodeName?: string } }) =>
          subject.nodeName === 'work'
            ? { action: 'fail', reason: 'the output leaked a secret' }
            : { action: 'pass' },
      })),
    );

    expect(error?.message).toMatch(/"work" was ended by middleware "Policy"/);
    expect(error?.message).toMatch(/leaked a secret/);
  });

  it('refuses a retry, because the seam that owns one sits inside this', async () => {
    const { graph } = graphOf();

    const { error } = await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: () => ({ action: 'retry' }),
      })),
    );

    expect(error).toBeInstanceOf(MiddlewareError);
    expect(error?.message).toMatch(/admits: pass, replace, fail/);
  });
});

describe('a node that failed', () => {
  it('reaches the after half once nodeError has let the error stand', async () => {
    const seen: Array<{ ok: boolean }> = [];
    const { graph } = graphOf({ failFor: 1 });

    const { error } = await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: ({ outcome }: { outcome: { ok: boolean } }) => {
          seen.push(outcome);
          return { action: 'pass' };
        },
      })),
    );

    // start succeeded, work failed. `pass` lets the failure stand, so the run
    // ends there and `done` is never reached.
    expect(seen.map((o) => o.ok)).toEqual([true, false]);
    expect(error?.message).toMatch(/work failed on attempt 1/);
  });

  it('can be rescued by the after half, with no nodeError policy at all', async () => {
    const { graph } = graphOf({ failFor: 1 });

    const { state } = await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: ({ outcome }: { outcome: { ok: boolean } }) =>
          outcome.ok
            ? { action: 'pass' }
            : { action: 'replace', value: { worked: 'rescued' } },
      })),
    );

    expect(state?.get('worked')).toBe('rescued');
  });

  it('is retried by nodeError without the after half seeing the attempt', async () => {
    const outcomes: boolean[] = [];
    const befores: string[] = [];
    const { graph } = graphOf({ failFor: 1 });

    const { state } = await run(
      graph,
      chainOf(
        policy({ node: ['before', 'after'] }, {
          before: ({ subject }: { subject: { nodeName?: string } }) => {
            befores.push(subject.nodeName ?? '');
            return { action: 'proceed' };
          },
          after: ({ outcome }: { outcome: { ok: boolean } }) => {
            outcomes.push(outcome.ok);
            return { action: 'pass' };
          },
        }),
        policy({ nodeError: ['after'] }, { after: () => ({ action: 'retry' }) }, 'Retry'),
      ),
    );

    // `work` is entered twice and settles once. A retry is a decision to execute
    // again, not an outcome — so the abandoned attempt gets a second `before`
    // and no `after`, and every `after` the chain sees is a settled one.
    expect(befores).toEqual(['start', 'work', 'work', 'done']);
    expect(outcomes).toEqual([true, true, true]);
    expect(state?.get('worked')).toBe(true);
  });

  it('tells the before half which attempt it is being asked about', async () => {
    const attempts: number[] = [];
    const { graph } = graphOf({ failFor: 1 });

    await run(
      graph,
      chainOf(
        policy({ node: ['before'] }, {
          before: (
            { subject }: { subject: { nodeName?: string } },
            ctx: { attempt: number; maxAttempts: number },
          ) => {
            if (subject.nodeName === 'work') attempts.push(ctx.attempt);
            return { action: 'proceed' };
          },
        }),
        policy({ nodeError: ['after'] }, { after: () => ({ action: 'retry' }) }, 'Retry'),
      ),
    );

    // Not [1, 1]. A cache that served the first attempt has to be able to tell
    // it is being asked again about a node that has since failed.
    expect(attempts).toEqual([1, 2]);
  });

  it('reports the middleware failure and the node failure together', async () => {
    const { graph } = graphOf({ failFor: 1 });

    const { error } = await run(
      graph,
      chainOf(policy({ node: ['after'] }, {
        after: ({ outcome }: { outcome: { ok: boolean } }) => {
          if (!outcome.ok) throw new Error('the policy itself broke');
          return { action: 'pass' };
        },
      })),
    );

    expect(error?.message).toMatch(/the policy itself broke/);
    expect(error?.message).toMatch(/work failed on attempt 1/);
  });
});

describe('a replaced node that chooses its own route', () => {
  it('says why the run cannot continue past it', async () => {
    const { graph } = graphOf({ branchOut: true });

    const { error } = await run(
      graph,
      chainOf(policy({ node: ['before'] }, {
        before: ({ subject }: { subject: { nodeName?: string } }) =>
          subject.nodeName === 'work'
            ? { action: 'replace', value: { worked: 'from the cache' } }
            : { action: 'proceed' },
      })),
    );

    expect(error?.message).toMatch(/supplies a result, never a route/);
    // No `Cause:` — nothing failed. The old message assumed a substitution
    // always followed an error, which was true when only `nodeError` could make
    // one.
    expect(error?.message).toMatch(/Nothing failed here/);
  });
});

describe('what the seam costs when nobody uses it', () => {
  it('runs a flow unchanged with no chain at all', async () => {
    const { graph, ran } = graphOf();

    const { state } = await run(graph);

    expect(ran()).toEqual(['start', 'work', 'done']);
    expect(state?.get('worked')).toBe(true);
  });

  it('asks neither half when nothing subscribes to it', async () => {
    let asked = 0;
    const { graph } = graphOf();

    await run(
      graph,
      chainOf(policy({ nodeError: ['after'] }, {
        after: () => {
          asked++;
          return { action: 'pass' };
        },
      })),
    );

    expect(asked).toBe(0);
  });

  it('still surfaces a node failure with no chain', async () => {
    const { graph } = graphOf({ failFor: 1 });

    const { error } = await run(graph);

    expect(error?.message).toMatch(/work failed on attempt 1/);
  });
});
