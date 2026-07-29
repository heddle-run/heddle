/**
 * The middleware kind, at the one seam heddle consults: `nodeError`.
 *
 * Before this, every node error was fatal and there was no extension point of
 * any kind on the failure path — a transient 429 from a tool ended the run.
 * These tests are mostly about the things that make an error handler safe
 * rather than about it working at all: that a retry cannot loop forever, that a
 * substituted result cannot follow a route nobody validated, and that a broken
 * policy is loud rather than absent.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { Event } from '../../runner/events.js';
import { State } from '../../state/state.js';
import { MAX_RETRY_DELAY, MiddlewareChain, MiddlewareError } from '../middleware.js';
import { PluginRegistry } from '../registry.js';
import { validateManifest } from '../manifest.js';
import { loadRemotePlugin } from '../remote-loader.js';
import { withRuntime } from '../runtime-source.js';
import { parseFlow } from '../../spec/parser.js';
import { compile } from '../../graph/compile.js';
import type { CompiledGraph, CompiledNode } from '../../graph/types.js';
import type {
  AfterVerdict,
  HeddlePlugin,
  MiddlewareContext,
  PluginMiddlewareDef,
  SeamOutcome,
} from '../types.js';

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-middleware-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A graph built by hand, so a node can be made to fail on demand.
//
// `parseFlow` cannot produce a node that throws, and the seam is only reachable
// when one does. The shape is the one the runner actually walks: a node with
// edges, an executor with `execute` and `branch`.
// ---------------------------------------------------------------------------

interface Failing {
  /** How many of the first attempts throw. `Infinity` never succeeds. */
  failFor: number;
  /** The branch the executor reports once it has succeeded. */
  branch?: string;
}

function failingGraph(spec: Failing, extraEdges: string[] = []): {
  graph: CompiledGraph;
  attempts: () => number;
} {
  let attempts = 0;
  let branch = '';

  const worker: CompiledNode = {
    name: 'work',
    type: 'ToolNode',
    specNode: { componentType: 'ToolNode', name: 'work' } as never,
    executor: {
      async execute(): Promise<State> {
        attempts++;
        if (attempts <= spec.failFor) {
          throw new Error(`work failed on attempt ${attempts}`);
        }
        branch = spec.branch ?? '';
        return new State({ worked: true, on_attempt: attempts });
      },
      branch: () => branch,
    },
    edges: [{ fromNode: 'work', toNode: 'done' }, ...extraEdges.map((b) => ({
      fromNode: 'work',
      fromBranch: b,
      toNode: `${b}_end`,
    }))],
    inputMappings: new Map(),
  };

  const nodes = new Map<string, CompiledNode>([['work', worker]]);
  for (const name of ['done', ...extraEdges.map((b) => `${b}_end`)]) {
    nodes.set(name, {
      name,
      type: 'EndNode',
      specNode: { componentType: 'EndNode', name } as never,
      executor: {
        execute: async (_s: AbortSignal | undefined, input: State) =>
          input.merge(new State({ ended_at: name })),
        branch: () => '',
      },
      edges: [],
      inputMappings: new Map(),
    });
  }

  const graph = {
    name: 'failing',
    start: 'work',
    getNode: (name: string) => nodes.get(name),
    nextNode: (current: CompiledNode, wanted: string) => {
      let fallback: CompiledNode | undefined;
      for (const edge of current.edges) {
        const edgeBranch = edge.fromBranch ?? '';
        if (wanted && edgeBranch === wanted) {
          const next = nodes.get(edge.toNode);
          if (next) return next;
        }
        if (!edgeBranch && !fallback) fallback = nodes.get(edge.toNode);
      }
      return fallback;
    },
  } as unknown as CompiledGraph;

  return { graph, attempts: () => attempts };
}

/**
 * A graph that comes back to the same node, so an arrival can be told from a
 * retry.
 *
 * `work` runs, then `turn` sends the run back to `work` until it has been
 * through twice, then out to `done`. The node's own failures are keyed on which
 * *arrival* this is rather than on a total attempt count, which is what lets a
 * test say "fail once on each visit" and observe whether the budget resets.
 */
function loopingGraph(spec: { failOnArrival: number[] }): {
  graph: CompiledGraph;
  arrivals: () => number;
} {
  let arrivals = 0;
  let attemptsThisArrival = 0;
  let laps = 0;

  const work: CompiledNode = {
    name: 'work',
    type: 'ToolNode',
    specNode: { componentType: 'ToolNode', name: 'work' } as never,
    executor: {
      async execute(): Promise<State> {
        if (attemptsThisArrival === 0) arrivals++;
        attemptsThisArrival++;
        if (spec.failOnArrival.includes(arrivals) && attemptsThisArrival === 1) {
          throw new Error(`work failed on arrival ${arrivals}`);
        }
        attemptsThisArrival = 0;
        return new State({ arrival: arrivals });
      },
      branch: () => '',
    },
    edges: [{ fromNode: 'work', toNode: 'turn' }],
    inputMappings: new Map(),
  };

  const turn: CompiledNode = {
    name: 'turn',
    type: 'BranchingNode',
    specNode: { componentType: 'BranchingNode', name: 'turn' } as never,
    executor: {
      async execute(): Promise<State> {
        laps++;
        return new State({ laps });
      },
      branch: () => (laps < 2 ? 'again' : 'out'),
    },
    edges: [
      { fromNode: 'turn', fromBranch: 'again', toNode: 'work' },
      { fromNode: 'turn', fromBranch: 'out', toNode: 'done' },
    ],
    inputMappings: new Map(),
  };

  const done: CompiledNode = {
    name: 'done',
    type: 'EndNode',
    specNode: { componentType: 'EndNode', name: 'done' } as never,
    executor: {
      execute: async (_s: AbortSignal | undefined, input: State) => input,
      branch: () => '',
    },
    edges: [],
    inputMappings: new Map(),
  };

  const nodes = new Map([
    ['work', work],
    ['turn', turn],
    ['done', done],
  ]);

  const graph = {
    name: 'looping',
    start: 'work',
    getNode: (name: string) => nodes.get(name),
    nextNode: (current: CompiledNode, wanted: string) => {
      let fallback: CompiledNode | undefined;
      for (const edge of current.edges) {
        const edgeBranch = edge.fromBranch ?? '';
        if (wanted && edgeBranch === wanted) {
          const next = nodes.get(edge.toNode);
          if (next) return next;
        }
        if (!edgeBranch && !fallback) fallback = nodes.get(edge.toNode);
      }
      return fallback;
    },
  } as unknown as CompiledGraph;

  return { graph, arrivals: () => arrivals };
}

/** An in-process middleware answering with whatever the test supplies. */
function middleware(
  componentType: string,
  after: (
    input: { subject: { nodeName?: string; nodeType?: string }; outcome: SeamOutcome },
    ctx: MiddlewareContext,
  ) => AfterVerdict | Promise<AfterVerdict>,
): PluginMiddlewareDef {
  return {
    componentType,
    seams: { nodeError: ['after'] },
    createMiddleware: () => ({ after }),
  };
}

function pluginWith(...defs: PluginMiddlewareDef[]): HeddlePlugin {
  return { name: 'policies', version: '1.0.0', middleware: defs };
}

function chainOf(...defs: PluginMiddlewareDef[]): MiddlewareChain {
  return MiddlewareChain.build(PluginRegistry.fromPlugins([pluginWith(...defs)]), {});
}

async function runWith(
  graph: CompiledGraph,
  chain: MiddlewareChain,
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
    return { state: await runner.run(undefined, {}), events };
  } catch (err) {
    return { error: err as Error, events };
  }
}

// ---------------------------------------------------------------------------
// The verdicts.
// ---------------------------------------------------------------------------

describe('the nodeError seam', () => {
  it('leaves the error alone when nothing is installed', async () => {
    const { graph, attempts } = failingGraph({ failFor: 1 });
    const { error } = await runWith(graph, MiddlewareChain.empty());

    expect(error?.message).toMatch(/work failed on attempt 1/);
    expect(attempts()).toBe(1);
  });

  it('leaves the error alone on a "pass" verdict', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { error } = await runWith(
      graph,
      chainOf(middleware('Watcher', () => ({ action: 'pass' }))),
    );

    expect(error?.message).toMatch(/work failed on attempt 1/);
  });

  it('retries a node until it succeeds', async () => {
    const { graph, attempts } = failingGraph({ failFor: 2 });
    const { state, error } = await runWith(
      graph,
      chainOf(middleware('RetryPolicy', () => ({ action: 'retry' }))),
    );

    expect(error).toBeUndefined();
    expect(attempts()).toBe(3);
    expect(state?.get('on_attempt')).toBe(3);
  });

  it('substitutes a result and carries on', async () => {
    const { graph, attempts } = failingGraph({ failFor: Infinity });
    const { state, error } = await runWith(
      graph,
      chainOf(
        middleware('Fallback', () => ({
          action: 'replace',
          value: { worked: false, canned: 'service unavailable' },
        })),
      ),
    );

    expect(error).toBeUndefined();
    expect(attempts()).toBe(1);
    expect(state?.get('canned')).toBe('service unavailable');
    expect(state?.get('ended_at')).toBe('done');
  });

  it('ends the run with the middleware\'s own reason on "fail"', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { error } = await runWith(
      graph,
      chainOf(
        middleware('Policy', () => ({ action: 'fail', reason: 'budget exhausted' })),
      ),
    );

    expect(error?.message).toMatch(/middleware "Policy" ended the run: budget exhausted/);
    // The node's own error is kept as the cause, because it is the diagnosis
    // and the middleware's reason is the decision.
    expect((error as Error & { cause?: Error }).cause?.message).toMatch(/work failed/);
  });

  it('passes the node and its error to the middleware, without the run\'s state', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    let seen: { subject: unknown; outcome: SeamOutcome } | undefined;

    await runWith(
      graph,
      chainOf(
        middleware('Inspect', (input) => {
          seen = input;
          return { action: 'pass' };
        }),
      ),
    );

    expect(seen?.subject).toEqual({ nodeName: 'work', nodeType: 'ToolNode' });
    expect(seen?.outcome).toEqual({
      ok: false,
      error: { name: 'Error', message: 'work failed on attempt 1' },
    });
    // No stack, and no node input: a middleware is installed by the operator
    // and named in nobody's document.
    expect(JSON.stringify(seen)).not.toMatch(/at Object|\.ts:/);
  });
});

// ---------------------------------------------------------------------------
// Retry safety. The part that is not about middleware working.
// ---------------------------------------------------------------------------

describe('the retry ceiling', () => {
  it('stops honouring retry at maxNodeAttempts and fails with the node\'s error', async () => {
    const { graph, attempts } = failingGraph({ failFor: Infinity });
    const { error, events } = await runWith(
      graph,
      chainOf(middleware('Forever', () => ({ action: 'retry' }))),
      { maxNodeAttempts: 3 },
    );

    expect(attempts()).toBe(3);
    expect(error?.message).toMatch(/work failed on attempt 3/);
    expect(error).not.toBeInstanceOf(MiddlewareError);

    const refusal = events.find(
      (e) => e.type === 'warning' && /heddle allows 3/.test(e.message ?? ''),
    );
    expect(refusal).toBeDefined();
  });

  it('still honours replace at the ceiling, so a last-resort fallback works', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    let consulted = 0;

    const { state, error } = await runWith(
      graph,
      chainOf(
        middleware('LastResort', (_input, ctx) => {
          consulted++;
          return ctx.attempt < ctx.maxAttempts
            ? { action: 'retry' }
            : { action: 'replace', value: { gave_up: true } };
        }),
      ),
      { maxNodeAttempts: 2 },
    );

    expect(error).toBeUndefined();
    expect(consulted).toBe(2);
    expect(state?.get('gave_up')).toBe(true);
  });

  it('lets a separate fallback answer when the retry policy is at the ceiling', async () => {
    // The natural two-plugin arrangement, and the one that breaks if the
    // ceiling is applied to the consult's result rather than handed into it: a
    // RetryPolicy that keeps asking, and a Fallback that has a canned answer
    // for the attempt after the last. Reverse registration order means the
    // RetryPolicy speaks first, so its refused retry must not end the consult.
    const { graph } = failingGraph({ failFor: Infinity });
    let fallbackConsulted = 0;

    const { state, error, events } = await runWith(
      graph,
      chainOf(
        middleware('Fallback', () => {
          fallbackConsulted++;
          return { action: 'replace', value: { gave_up: true } };
        }),
        middleware('RetryPolicy', () => ({ action: 'retry' })),
      ),
      { maxNodeAttempts: 2 },
    );

    expect(error).toBeUndefined();
    expect(state?.get('gave_up')).toBe(true);
    // Once on the last attempt, after RetryPolicy's retry was refused. Not on
    // the first: there the retry won and short-circuited the chain, which is
    // the behaviour that makes "first non-pass wins" mean anything.
    expect(fallbackConsulted).toBe(1);
    expect(
      events.find(
        (e) => e.type === 'warning' && /retry is refused and the rest of the chain/.test(e.message ?? ''),
      ),
    ).toBeDefined();
  });

  it('spends an iteration per retry, so maxIterations is the real bound', async () => {
    const { graph, attempts } = failingGraph({ failFor: Infinity });
    const { error } = await runWith(
      graph,
      chainOf(middleware('Forever', () => ({ action: 'retry' }))),
      // A ceiling high enough that maxIterations is what stops it.
      { maxNodeAttempts: 100, maxIterations: 4 },
    );

    expect(attempts()).toBe(4);
    expect(error?.message).toMatch(/exceeded max iterations \(4\)/);
    // And the message says the graph may be innocent, because "exceeded max
    // iterations" otherwise sends whoever reads it to look at the graph.
    expect(error?.message).toMatch(/middleware retries/);
  });

  it('gives each arrival at a node its own budget', async () => {
    // A loop, because that is the only shape in which the reset is observable:
    // in an acyclic graph the failing node is arrived at once, and the counter
    // would read 1 whether or not anything ever reset it.
    const { graph, arrivals } = loopingGraph({ failOnArrival: [1, 2] });
    const seen: number[] = [];

    const { state, error } = await runWith(
      graph,
      chainOf(
        middleware('Count', (_input, ctx) => {
          seen.push(ctx.attempt);
          return { action: 'retry' };
        }),
      ),
      { maxNodeAttempts: 2 },
    );

    expect(error).toBeUndefined();
    // Two arrivals, each failing once and retrying once, and each starting its
    // count again — not 1 then 2.
    expect(seen).toEqual([1, 1]);
    expect(arrivals()).toBe(2);
    expect(state?.get('laps')).toBe(2);
  });

  it('clamps an unreasonable delay, and waits the clamped one', async () => {
    // `maxNodeAttempts: 2`, so the retry is actually honoured and the runner
    // reaches the sleep. At the ceiling the retry is refused before a delay is
    // ever computed, so a test that pins the clamp through its warning alone
    // asserts a number that was logged and thrown away.
    const { graph } = failingGraph({ failFor: Infinity });
    vi.useFakeTimers();
    try {
      const run = runWith(
        graph,
        chainOf(middleware('Slow', () => ({ action: 'retry', delayMs: 3_600_000 }))),
        { maxNodeAttempts: 2 },
      );

      // One tick short of the clamp, the run is still waiting.
      await vi.advanceTimersByTimeAsync(MAX_RETRY_DELAY - 1);
      let settled = false;
      void run.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      const { events, error } = await run;

      expect(error?.message).toMatch(/work failed/);
      const clamped = events.find(
        (e) => e.type === 'warning' && /asked to wait 3600000ms/.test(e.message ?? ''),
      );
      expect(clamped?.message).toMatch(/heddle waits 30000ms/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an abort during a retry delay as the abort it is', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    const ac = new AbortController();

    const runner = new Runner(graph, {
      ...DEFAULT_RUNNER_OPTIONS,
      maxNodeAttempts: 10,
      middleware: chainOf(
        middleware('Slow', () => {
          // Aborted while the runner is inside the delay, which is the case
          // the sleep has to survive: it resolves rather than rejecting, and
          // the loop's own check reports it.
          setTimeout(() => ac.abort(), 10);
          return { action: 'retry', delayMs: 5_000 };
        }),
      ),
    });

    await expect(runner.run(ac.signal, {})).rejects.toThrow(/aborted/);
  });
});

// ---------------------------------------------------------------------------
// Routing a substituted result.
// ---------------------------------------------------------------------------

describe('a replaced node', () => {
  it('takes the unbranched edge rather than a branch it never chose', async () => {
    // The node reports "hot" once it succeeds, and there is a "hot" edge to
    // follow. On the visit that fails it reports nothing — but `branch()` reads
    // state written on the last *successful* run and never resets, so a
    // substituted result must not consult it.
    const { graph } = failingGraph({ failFor: 0, branch: 'hot' }, ['hot']);

    // First visit succeeds and leaves _branch = "hot" behind.
    const first = await runWith(graph, MiddlewareChain.empty());
    expect(first.state?.get('ended_at')).toBe('hot_end');

    // Second run of the same compiled graph: the node fails, and the executor
    // still says "hot" if anybody asks.
    const stale = failingGraph({ failFor: Infinity }, ['hot']);
    (stale.graph.getNode('work') as CompiledNode).executor.branch = () => 'hot';

    const second = await runWith(
      stale.graph,
      chainOf(middleware('Fallback', () => ({ action: 'replace', value: { ok: false } }))),
    );

    expect(second.error).toBeUndefined();
    expect(second.state?.get('ended_at')).toBe('done');
  });
});

// ---------------------------------------------------------------------------
// Composition, and what happens when a middleware itself breaks.
// ---------------------------------------------------------------------------

describe('a chain of middleware', () => {
  it('evaluates in reverse registration order and stops at the first verdict', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    const order: string[] = [];

    const chain = chainOf(
      middleware('First', () => {
        order.push('First');
        return { action: 'pass' };
      }),
      middleware('Second', () => {
        order.push('Second');
        return { action: 'pass' };
      }),
      middleware('Third', () => {
        order.push('Third');
        return { action: 'replace', value: { by: 'Third' } };
      }),
    );

    const { state } = await runWith(graph, chain);

    // Reverse of load order, and First is never consulted because Third spoke.
    expect(order).toEqual(['Third']);
    expect(state?.get('by')).toBe('Third');
  });

  it('lets an earlier-loaded middleware have the last word', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    const chain = chainOf(
      middleware('Outer', () => ({ action: 'replace', value: { winner: 'Outer' } })),
      middleware('Inner', () => ({ action: 'pass' })),
    );

    const { state } = await runWith(graph, chain);
    expect(state?.get('winner')).toBe('Outer');
  });

  it('fails the run when a middleware throws, naming it', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { error } = await runWith(
      graph,
      chainOf(
        middleware('Broken', () => {
          throw new Error('policy is misconfigured');
        }),
      ),
    );

    expect(error).toBeInstanceOf(MiddlewareError);
    expect(error?.message).toMatch(/middleware "Broken" \(plugin "policies"\)/);
    expect(error?.message).toMatch(/policy is misconfigured/);

    // Both failures, because two different people have to act on them. The
    // flow's author did not install this middleware and may not know it exists;
    // the node's own error is the part they can do something about, and burying
    // it in a `cause` nobody prints is how it goes missing.
    expect(error?.message).toMatch(/work failed on attempt 1/);
    expect(error?.message).toMatch(/installed by whoever runs heddle/);
    expect((error as MiddlewareError).cause).toBeInstanceOf(Error);
    expect(((error as MiddlewareError).cause as Error).message).toMatch(/work failed/);
  });

  it('fails the run when a middleware answers with nonsense', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { error } = await runWith(
      graph,
      chainOf(
        middleware('Confused', () => ({ action: 'carry_on' } as unknown as AfterVerdict)),
      ),
    );

    // Same class as a middleware that threw, and deliberately: an unusable
    // verdict is the middleware being wrong, and which side of a process
    // boundary it was written on must not change what the failure is called.
    expect(error).toBeInstanceOf(MiddlewareError);
    expect(error?.message).toMatch(/returned action "carry_on"/);
    expect(error?.message).toMatch(/admits: pass, replace, retry, fail/);
  });

  it('refuses a "fail" with no reason, which would lose the only diagnosis', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { error } = await runWith(
      graph,
      chainOf(middleware('Terse', () => ({ action: 'fail', reason: '' }))),
    );

    expect(error).toBeInstanceOf(MiddlewareError);
    expect(error?.message).toMatch(/returned "fail" without a "reason"/);
  });

  it('gives a remote middleware\'s bad verdict the same class as an in-process one', async () => {
    const entry = join(scratch, 'remote-nonsense.mjs');
    writeFileSync(
      entry,
      withRuntime(
        `serve({ RetryPolicy: { nodeError: { after: () => ({ action: 'carry_on' }) } } });`,
      ),
    );
    const remote = loadRemotePlugin(
      {
        name: 'resilience',
        version: '1.0.0',
        capabilities: [],
        components: [
          { componentType: 'RetryPolicy', kind: 'middleware', seams: { nodeError: ['after'] } },
        ],
      },
      entry,
      { timeout: 10_000 },
    );
    const registry = PluginRegistry.empty();
    registry.addRemote(remote);

    try {
      const { graph } = failingGraph({ failFor: 1 });
      const { error } = await runWith(graph, MiddlewareChain.build(registry, {}));

      expect(error).toBeInstanceOf(MiddlewareError);
      expect(error?.message).toMatch(/returned action "carry_on"/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// What a client sees.
// ---------------------------------------------------------------------------

describe('the events a retry produces', () => {
  it('numbers each attempt, so a retry is not read as a loop', async () => {
    const { graph } = failingGraph({ failFor: 2 });
    const { events } = await runWith(
      graph,
      chainOf(middleware('RetryPolicy', () => ({ action: 'retry' }))),
    );

    const starts = events.filter((e) => e.type === 'node_start' && e.nodeName === 'work');
    expect(starts.map((e) => e.attempt)).toEqual([1, 2, 3]);

    const errors = events.filter((e) => e.type === 'node_error');
    expect(errors.map((e) => e.attempt)).toEqual([1, 2]);

    const complete = events.find(
      (e) => e.type === 'node_complete' && e.nodeName === 'work',
    );
    expect(complete?.attempt).toBe(3);
  });

  it('warns when a retry is granted, naming the middleware and the cause', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { events } = await runWith(
      graph,
      chainOf(middleware('RetryPolicy', () => ({ action: 'retry' }))),
    );

    const warning = events.find((e) => e.type === 'warning');
    expect(warning?.message).toMatch(/"RetryPolicy" is retrying "work"/);
    expect(warning?.message).toMatch(/attempt 1 of 3/);
    expect(warning?.message).toMatch(/Cause: work failed on attempt 1/);
  });

  it('warns when a result is substituted, so nobody reads it as the node\'s own', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    const { events } = await runWith(
      graph,
      chainOf(middleware('Fallback', () => ({ action: 'replace', value: {} }))),
    );

    const warning = events.find((e) => e.type === 'warning');
    expect(warning?.message).toMatch(/"Fallback" supplied a result for "work"/);
    expect(warning?.message).toMatch(/The node did not produce this/);
  });

  it('files a middleware\'s own events under the node that failed', async () => {
    const { graph } = failingGraph({ failFor: 1 });
    const { events } = await runWith(
      graph,
      chainOf(
        middleware('Noisy', (_input, ctx) => {
          ctx.emitEvent('considering', { attempt: ctx.attempt });
          ctx.log('warn', 'retrying');
          return { action: 'pass' };
        }),
      ),
    );

    const emitted = events.find((e) => e.type === 'plugin:Noisy:considering');
    expect(emitted?.nodeName).toBe('work');
    expect(emitted?.nodeType).toBe('Noisy');
    expect(emitted?.data).toEqual({ attempt: 1 });

    const logged = events.find((e) => e.type === 'plugin_log');
    expect(logged?.level).toBe('warn');
    expect(logged?.nodeName).toBe('work');
  });
});

// ---------------------------------------------------------------------------
// The manifest, which is where a middleware says what it hooks.
// ---------------------------------------------------------------------------

describe('declaring a middleware', () => {
  const base = { name: 'p', version: '1.0.0', capabilities: [] };

  function withComponent(component: Record<string, unknown>): () => unknown {
    return () => validateManifest({ ...base, components: [component] });
  }

  it('accepts a middleware that subscribes to nodeError', () => {
    const manifest = validateManifest({
      ...base,
      components: [
        { componentType: 'RetryPolicy', kind: 'middleware', seams: { nodeError: ['after'] } },
      ],
    });
    expect(manifest.components[0].seams).toEqual({ nodeError: ['after'] });
  });

  it('refuses a middleware that declares no seams', () => {
    expect(withComponent({ componentType: 'Nowhere', kind: 'middleware' })).toThrow(
      /must declare "seams"/,
    );
  });

  it('refuses "seams" on a kind that has none', () => {
    expect(
      withComponent({ componentType: 'ANode', seams: { nodeError: ['after'] } }),
    ).toThrow(/declares "seams" but its kind is "node"/);
  });

  it('refuses a seam heddle has never heard of', () => {
    expect(
      withComponent({ componentType: 'M', kind: 'middleware', seams: { onVibes: ['after'] } }),
    ).toThrow(/"onVibes", which is not a seam/);
  });

  it('refuses a seam heddle knows but does not consult yet', () => {
    expect(
      withComponent({ componentType: 'M', kind: 'middleware', seams: { toolCall: ['after'] } }),
    ).toThrow(/does not consult yet/);
  });

  it('refuses a half the seam does not have', () => {
    expect(
      withComponent({ componentType: 'M', kind: 'middleware', seams: { nodeError: ['before'] } }),
    ).toThrow(/has no such half/);
  });
});

// ---------------------------------------------------------------------------
// A middleware has no document, so its configuration is the operator's.
// ---------------------------------------------------------------------------

describe('the configuration channel', () => {
  function writeMiddleware(name: string, body: string): string {
    const entry = join(scratch, `${name}.mjs`);
    writeFileSync(entry, withRuntime(body));
    return entry;
  }

  const RETRY_MANIFEST = {
    name: 'resilience',
    version: '1.0.0',
    capabilities: [],
    components: [
      {
        componentType: 'RetryPolicy',
        kind: 'middleware',
        seams: { nodeError: ['after'] },
        schema: {
          type: 'object',
          properties: { maxAttempts: { type: 'integer', minimum: 1 } },
          required: ['maxAttempts'],
        },
      },
    ],
  };

  /**
   * The operator's real channel, end to end.
   *
   * Every one of these goes through `MiddlewareChain.build`, because that is
   * where an operator's configuration actually arrives — `--plugin-config`
   * lands there and nowhere else. There was briefly a second channel on the
   * loader's options which was validated and then dropped, and the reason it
   * survived a green suite is worth remembering: the validation tests drove the
   * dead channel and the delivery test drove the live one, so each half looked
   * correct and no test ever asked the same object to do both.
   */
  function chainFrom(
    manifest: unknown,
    entry: string,
    config: Record<string, Record<string, unknown>> = {},
  ): MiddlewareChain {
    const registry = PluginRegistry.empty();
    registry.addRemote(loadRemotePlugin(manifest, entry, {}));
    return MiddlewareChain.build(registry, {}, config);
  }

  it('refuses a configuration the manifest schema rejects', () => {
    const entry = writeMiddleware('cfg-bad', 'serve({});');
    expect(() => chainFrom(RETRY_MANIFEST, entry, { RetryPolicy: { maxAttempts: 'lots' } })).toThrow(
      /maxAttempts/,
    );
  });

  it('refuses a middleware whose required configuration was never supplied', () => {
    const entry = writeMiddleware('cfg-missing', 'serve({});');
    expect(() => chainFrom(RETRY_MANIFEST, entry)).toThrow(
      /configuration for "RetryPolicy".*maxAttempts/s,
    );
  });

  it('refuses configuration no loaded middleware claims', () => {
    const entry = writeMiddleware('cfg-typo', 'serve({});');
    expect(() =>
      chainFrom(RETRY_MANIFEST, entry, {
        RetryPolicy: { maxAttempts: 2 },
        RetryPolicee: { maxAttempts: 2 },
      }),
    ).toThrow(/"RetryPolicee", which no loaded plugin provides as a middleware/);
  });

  it('refuses configuration when no middleware is loaded at all', () => {
    expect(() =>
      MiddlewareChain.build(PluginRegistry.empty(), {}, { RetryPolicy: { maxAttempts: 2 } }),
    ).toThrow(/No middleware is loaded at all/);
  });

  it('delivers the configuration the schema validated, over the wire', async () => {
    const entry = writeMiddleware(
      'cfg-live',
      `serve({ RetryPolicy: { nodeError: { after: (_i, ctx) =>
         ({ action: 'replace', value: { budget: ctx.component.maxAttempts } }) } } });`,
    );
    const chain = chainFrom(RETRY_MANIFEST, entry, { RetryPolicy: { maxAttempts: 4 } });
    const { graph } = failingGraph({ failFor: Infinity });

    const { state, error } = await runWith(graph, chain);
    expect(error).toBeUndefined();
    expect(state?.get('budget')).toBe(4);
  });

  it('reads an llm_config written the way the error message asks for it', () => {
    const entry = writeMiddleware('cfg-llm', 'serve({});');
    const chain = chainFrom(
      {
        ...RETRY_MANIFEST,
        components: [{ ...RETRY_MANIFEST.components[0], schema: undefined }],
      },
      entry,
      { RetryPolicy: { llm_config: { component_type: 'OpenAiConfig', model_id: 'gpt-4o-mini' } } },
    );

    // The operator's configuration never meets the SDK deserializer, so the
    // snake_case spelling `PluginModel` tells them to write would otherwise be
    // invisible to the camelCase spelling it reads.
    expect(chain.describe()).toEqual(['RetryPolicy (resilience) on nodeError']);
  });

  it('hands the validated configuration to the middleware as ctx.component', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    let seen: unknown;

    const chain = MiddlewareChain.build(
      PluginRegistry.fromPlugins([
        pluginWith({
          componentType: 'Configured',
          seams: { nodeError: ['after'] },
          createMiddleware: (config) => ({
            after: (_input, ctx) => {
              seen = ctx.component;
              return { action: 'replace', value: { budget: config.maxAttempts } };
            },
          }),
        }),
      ]),
      {},
      { Configured: { maxAttempts: 7 } },
    );

    const { state } = await runWith(graph, chain);
    expect(seen).toEqual({ maxAttempts: 7 });
    expect(state?.get('budget')).toBe(7);
  });

  it('gives a middleware with no configuration an empty object, not undefined', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    let seen: unknown = 'unset';

    await runWith(
      graph,
      chainOf(
        middleware('Bare', (_input, ctx) => {
          seen = ctx.component;
          return { action: 'replace', value: {} };
        }),
      ),
    );

    expect(seen).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// A spec cannot name one, which is the whole of "host-configured".
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The failure paths that are not the node's.
// ---------------------------------------------------------------------------

describe('what a middleware is not asked about', () => {
  it('does not consult the chain when the run was aborted', async () => {
    // The node threw *because* the run ended, so there is nothing to retry
    // into. Consulting anyway would also charge it to the wrong party: the host
    // refuses a call on an aborted signal, the chain reads any throw as the
    // middleware failing, and the run would end with a MiddlewareError blaming
    // the operator's plugin for heddle's own cancellation.
    const ac = new AbortController();
    let consulted = 0;

    const aborting: CompiledNode = {
      name: 'work',
      type: 'ToolNode',
      specNode: { componentType: 'ToolNode', name: 'work' } as never,
      executor: {
        async execute(): Promise<State> {
          ac.abort();
          throw new Error('execution aborted');
        },
        branch: () => '',
      },
      edges: [{ fromNode: 'work', toNode: 'done' }],
      inputMappings: new Map(),
    };
    const nodes = new Map([['work', aborting]]);
    const graph = {
      name: 'aborting',
      start: 'work',
      getNode: (name: string) => nodes.get(name),
      nextNode: () => undefined,
    } as unknown as CompiledGraph;

    const runner = new Runner(graph, {
      ...DEFAULT_RUNNER_OPTIONS,
      middleware: chainOf(
        middleware('Never', () => {
          consulted++;
          return { action: 'retry' };
        }),
      ),
    });

    await expect(runner.run(ac.signal, {})).rejects.toThrow(/execution aborted/);
    expect(consulted).toBe(0);
  });

  it('names the middleware when a replaced node has no unbranched edge to take', async () => {
    // The shape `examples/guardrails` ships: a BranchingNode whose every edge
    // carries a branch. A replaced node routes on '' because `executor.branch()`
    // holds the branch of a previous *successful* visit — so there is nothing
    // for it to take, and "no next node" would send whoever reads it to the
    // graph for a decision the middleware made.
    const branching: CompiledNode = {
      name: 'route',
      type: 'BranchingNode',
      specNode: { componentType: 'BranchingNode', name: 'route' } as never,
      executor: {
        async execute(): Promise<State> {
          throw new Error('no branching_mapping_key in input');
        },
        branch: () => '',
      },
      edges: [
        { fromNode: 'route', fromBranch: 'ok', toNode: 'end_ok' },
        { fromNode: 'route', fromBranch: 'blocked', toNode: 'end_blocked' },
      ],
      inputMappings: new Map(),
    };
    const ends = ['end_ok', 'end_blocked'].map((name): [string, CompiledNode] => [
      name,
      {
        name,
        type: 'EndNode',
        specNode: { componentType: 'EndNode', name } as never,
        executor: { execute: async () => new State({}), branch: () => '' },
        edges: [],
        inputMappings: new Map(),
      },
    ]);
    const nodes = new Map<string, CompiledNode>([['route', branching], ...ends]);
    const graph = {
      name: 'branching',
      start: 'route',
      getNode: (name: string) => nodes.get(name),
      nextNode: (current: CompiledNode, wanted: string) => {
        for (const edge of current.edges) {
          if (wanted && (edge.fromBranch ?? '') === wanted) return nodes.get(edge.toNode);
        }
        return undefined;
      },
    } as unknown as CompiledGraph;

    const { error } = await runWith(
      graph,
      chainOf(middleware('Fallback', () => ({ action: 'replace', value: { ok: true } }))),
    );

    expect(error?.message).toMatch(/middleware "Fallback" supplied a result/);
    expect(error?.message).toMatch(/supplies a result, never a route/);
    expect(error?.message).toMatch(/no branching_mapping_key/);
  });

  it('refuses an in-process subscription the manifest path would have refused', () => {
    // `seams: { toolCall: ['after'] }` type-checks — `toolCall` is a Seam — and
    // would otherwise load, print in --verbose, and never be consulted. A
    // middleware that is silently never called reads to its author as one that
    // does not work, and being written in the same process as heddle does not
    // earn that.
    expect(() =>
      chainOf({
        componentType: 'TooEarly',
        seams: { toolCall: ['after'] },
        createMiddleware: () => ({ after: () => ({ action: 'pass' }) }),
      }),
    ).toThrow(/does not consult yet/);

    expect(() =>
      chainOf({
        componentType: 'WrongHalf',
        seams: { nodeError: ['before'] },
        createMiddleware: () => ({ after: () => ({ action: 'pass' }) }),
      }),
    ).toThrow(/has no such half/);

    expect(() =>
      chainOf({
        componentType: 'Nowhere',
        seams: {},
        createMiddleware: () => ({ after: () => ({ action: 'pass' }) }),
      }),
    ).toThrow(/nothing in it/);
  });

  it('cannot be given a component type that names something on Object.prototype', () => {
    // `NAME` in the manifest validator admits `constructor`, `toString` and
    // `valueOf`, so a config map indexed by component type could in principle
    // hand an unconfigured middleware something off the prototype instead of
    // the `{}` its contract promises. It cannot, and this is why: `claim`
    // refuses every one of these first, because the SDK's own
    // `isBuiltinComponentType` answers true for them. The lookup in
    // `MiddlewareChain.build` uses `Object.hasOwn` anyway — this is the reason
    // that is belt and braces rather than the thing holding the line.
    for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(() =>
        PluginRegistry.fromPlugins([
          pluginWith(middleware(name, () => ({ action: 'pass' }))),
        ]),
      ).toThrow(/builtin Agent Spec type/);
    }
  });
});

describe('a spec that names a middleware', () => {
  it('is refused with the reason, rather than as an unknown component type', () => {
    const registry = PluginRegistry.fromPlugins([
      pluginWith(middleware('RetryPolicy', () => ({ action: 'pass' }))),
    ]);

    const spec = JSON.stringify({
      component_type: 'Flow',
      name: 'f',
      nodes: [
        { component_type: 'StartNode', name: 'start', outputs: [{ title: 'q', type: 'string' }] },
        { component_type: 'RetryPolicy', name: 'policy' },
        { component_type: 'EndNode', name: 'end' },
      ],
      control_flow_connections: [
        { from_node: 'start', to_node: 'policy' },
        { from_node: 'policy', to_node: 'end' },
      ],
      start_node: 'start',
      end_nodes: ['end'],
    });

    expect(() => parseFlow(spec, registry)).toThrow(/which is a middleware/);
  });

  it('is not offered as a component type a spec could use', () => {
    const registry = PluginRegistry.fromPlugins([
      pluginWith(middleware('RetryPolicy', () => ({ action: 'pass' }))),
    ]);
    expect(registry.componentTypeNames()).not.toContain('RetryPolicy');
    expect(registry.kindOf('RetryPolicy')).toBe('middleware');
    expect(registry.middlewareDefs().map((m) => m.def.componentType)).toEqual([
      'RetryPolicy',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The same thing, in its own process.
// ---------------------------------------------------------------------------

describe('an out-of-process middleware', () => {
  const MANIFEST = {
    name: 'resilience',
    version: '1.0.0',
    capabilities: [],
    components: [
      { componentType: 'RetryPolicy', kind: 'middleware', seams: { nodeError: ['after'] } },
    ],
  };

  function writePlugin(name: string, body: string): string {
    const entry = join(scratch, `${name}.mjs`);
    writeFileSync(entry, withRuntime(body));
    return entry;
  }

  it('retries a node from another process', async () => {
    const entry = writePlugin(
      'remote-retry',
      `serve({
         RetryPolicy: {
           nodeError: {
             after: (input, ctx) =>
               ctx.attempt < 3 ? { action: 'retry' } : { action: 'pass' },
           },
         },
       });`,
    );
    const remote = loadRemotePlugin(MANIFEST, entry, { timeout: 10_000 });
    const registry = PluginRegistry.empty();
    registry.addRemote(remote);

    try {
      const { graph, attempts } = failingGraph({ failFor: 2 });
      const { state, error } = await runWith(
        graph,
        MiddlewareChain.build(registry, {}),
      );

      expect(error).toBeUndefined();
      expect(attempts()).toBe(3);
      expect(state?.get('on_attempt')).toBe(3);
    } finally {
      registry.dispose();
    }
  });

  it('receives the subject, the outcome and the seam over the wire', async () => {
    const entry = writePlugin(
      'remote-echo',
      `serve({
         RetryPolicy: {
           nodeError: {
             after: (input, ctx) => ({
               action: 'replace',
               value: {
                 seam: ctx.seam,
                 node: input.subject.nodeName,
                 why: input.outcome.error.message,
                 admits: ctx.admits,
                 config: ctx.component,
               },
             }),
           },
         },
       });`,
    );
    const remote = loadRemotePlugin(MANIFEST, entry, { timeout: 10_000 });
    const registry = PluginRegistry.empty();
    registry.addRemote(remote);

    try {
      const { graph } = failingGraph({ failFor: Infinity });
      const { state, error } = await runWith(
        graph,
        MiddlewareChain.build(registry, {}, { RetryPolicy: { note: 'hello' } }),
      );

      expect(error).toBeUndefined();
      expect(state?.get('seam')).toBe('nodeError');
      expect(state?.get('node')).toBe('work');
      expect(state?.get('why')).toMatch(/work failed/);
      // The handshake told it what this seam honours.
      expect(state?.get('admits')).toEqual(['pass', 'replace', 'retry', 'fail']);
      expect(state?.get('config')).toEqual({ note: 'hello' });
    } finally {
      registry.dispose();
    }
  });

  it('reports a middleware that declares a seam but implements no handler', async () => {
    const entry = writePlugin('remote-empty', `serve({ RetryPolicy: {} });`);
    const remote = loadRemotePlugin(MANIFEST, entry, { timeout: 10_000 });
    const registry = PluginRegistry.empty();
    registry.addRemote(remote);

    try {
      const { graph } = failingGraph({ failFor: 1 });
      const { error } = await runWith(graph, MiddlewareChain.build(registry, {}));

      expect(error).toBeInstanceOf(MiddlewareError);
      expect(error?.message).toMatch(/provides no handler for it/);
    } finally {
      registry.dispose();
    }
  });

  it('fails the run when the plugin\'s process dies mid-consult', async () => {
    const entry = writePlugin(
      'remote-dies',
      `serve({
         RetryPolicy: { nodeError: { after: () => { process.exit(1); } } },
       });`,
    );
    const remote = loadRemotePlugin(MANIFEST, entry, { timeout: 10_000 });
    const registry = PluginRegistry.empty();
    registry.addRemote(remote);

    try {
      const { graph } = failingGraph({ failFor: 1 });
      const { error } = await runWith(graph, MiddlewareChain.build(registry, {}));

      expect(error).toBeInstanceOf(MiddlewareError);
      expect(error?.message).toMatch(/exited/);
    } finally {
      registry.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Compiling a flow is unaffected by a middleware being installed.
// ---------------------------------------------------------------------------

describe('a flow compiled alongside middleware', () => {
  it('runs exactly as it would without one, when nothing fails', async () => {
    const spec = readFileSync(
      join(import.meta.dirname, '../../../testdata/simple_flow.json'),
      'utf-8',
    );

    const registry = PluginRegistry.fromPlugins([
      pluginWith(
        middleware('NeverCalled', () => {
          throw new Error('a healthy run must not consult the nodeError seam');
        }),
      ),
    ]);

    const graph = compile(parseFlow(spec, registry), { plugins: registry });
    const events: Event[] = [];
    const runner = new Runner(graph, {
      ...DEFAULT_RUNNER_OPTIONS,
      middleware: MiddlewareChain.build(registry, {}),
      eventHandler: (e) => events.push(e),
    });

    const state = await runner.run(undefined, { input: 'hello' });
    expect(state.get('input')).toBe('hello');
    expect(events.some((e) => e.type === 'warning')).toBe(false);
  });
});
