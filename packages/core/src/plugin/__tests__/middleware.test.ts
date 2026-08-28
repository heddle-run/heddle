import { describe, it, expect, vi } from 'vitest';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type { Event } from '../../runner/events.js';
import { State } from '../../state/state.js';
import { MAX_RETRY_DELAY, MiddlewareChain, MiddlewareError } from '../middleware.js';
import { PluginRegistry } from '../registry.js';
import { validateManifest } from '../manifest.js';
import { loadRemotePlugin } from '../remote-loader.js';
import { parseFlow } from '../../spec/parser.js';
import { compile } from '../../graph/compile.js';
import { CompiledGraph, type CompiledNode, type GraphNodeSpec } from '../../graph/types.js';
import type {
  MiddlewareContext,
  PluginMiddlewareDef,
  SeamOutcome,
} from '../types.js';
import type { AfterVerdict } from '../protocol.js';
import { useScratch } from './helpers/remote-plugin.js';
import { chainOf, pluginWith } from './helpers/seams.js';

const scratch = useScratch('heddle-middleware-');

function stepSpec(): GraphNodeSpec {
  return { role: 'step', step: {} as never };
}

function outcomeSpec(name: string): GraphNodeSpec {
  return { role: 'outcome', outcome: { name } };
}

interface Failing {
  failFor: number;
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
    type: 'tool',
    spec: stepSpec(),
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
    edges: [
      { from: 'work', to: 'done' },
      ...extraEdges.map((b) => ({ from: 'work', branch: b, to: `${b}_end` })),
    ],
    inputMappings: new Map(),
  };

  const nodes = new Map<string, CompiledNode>([['work', worker]]);
  for (const name of ['done', ...extraEdges.map((b) => `${b}_end`)]) {
    nodes.set(name, {
      name,
      type: 'outcome',
      spec: outcomeSpec(name),
      executor: {
        execute: async (_s: AbortSignal | undefined, input: State) =>
          input.merge(new State({ ended_at: name })),
        branch: () => '',
      },
      edges: [],
      inputMappings: new Map(),
    });
  }

  return { graph: new CompiledGraph('failing', nodes, 'work'), attempts: () => attempts };
}

/**
 * A graph the runner walks around twice — hand-built, because a Weave document
 * cannot write a loop, and the per-arrival attempt budget is the runner's own
 * mechanism rather than the format's.
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
    type: 'tool',
    spec: stepSpec(),
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
    edges: [{ from: 'work', to: 'turn' }],
    inputMappings: new Map(),
  };

  const turn: CompiledNode = {
    name: 'turn',
    type: 'switch',
    spec: stepSpec(),
    executor: {
      async execute(): Promise<State> {
        laps++;
        return new State({ laps });
      },
      branch: () => (laps < 2 ? 'again' : 'out'),
    },
    edges: [
      { from: 'turn', branch: 'again', to: 'work' },
      { from: 'turn', branch: 'out', to: 'done' },
    ],
    inputMappings: new Map(),
  };

  const done: CompiledNode = {
    name: 'done',
    type: 'outcome',
    spec: outcomeSpec('done'),
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

  return { graph: new CompiledGraph('looping', nodes, 'work'), arrivals: () => arrivals };
}

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

describe('the nodeError seam', () => {
  it('leaves the error alone when nothing is installed', async () => {
    const { graph, attempts } = failingGraph({ failFor: 1 });
    const { error } = await runWith(
      graph,
      MiddlewareChain.build(undefined, {}),
    );

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

    expect(seen?.subject).toEqual({ nodeName: 'work', nodeType: 'tool' });
    expect(seen?.outcome).toEqual({
      ok: false,
      error: { name: 'Error', message: 'work failed on attempt 1' },
    });
    expect(JSON.stringify(seen)).not.toMatch(/at Object|\.ts:/);
  });
});

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
      { maxNodeAttempts: 100, maxIterations: 4 },
    );

    expect(attempts()).toBe(4);
    expect(error?.message).toMatch(/exceeded max iterations \(4\)/);
    expect(error?.message).toMatch(/middleware retries/);
  });

  it('gives each arrival at a node its own budget', async () => {
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
    expect(seen).toEqual([1, 1]);
    expect(arrivals()).toBe(2);
    expect(state?.get('laps')).toBe(2);
  });

  it('clamps an unreasonable delay, and waits the clamped one', async () => {
    const { graph } = failingGraph({ failFor: Infinity });
    vi.useFakeTimers();
    try {
      const run = runWith(
        graph,
        chainOf(middleware('Slow', () => ({ action: 'retry', delayMs: 3_600_000 }))),
        { maxNodeAttempts: 2 },
      );

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
          setTimeout(() => ac.abort(), 10);
          return { action: 'retry', delayMs: 5_000 };
        }),
      ),
    });

    await expect(runner.run(ac.signal, {})).rejects.toThrow(/aborted/);
  });
});

describe('a replaced node', () => {
  it('takes the unbranched edge rather than a branch it never chose', async () => {
    const { graph } = failingGraph({ failFor: 0, branch: 'hot' }, ['hot']);

    const first = await runWith(graph, MiddlewareChain.build(undefined, {}));
    expect(first.state?.get('ended_at')).toBe('hot_end');

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
    const entry = scratch.writeHelperPlugin(
      'remote-nonsense',
      `serve({ RetryPolicy: { nodeError: { after: () => ({ action: 'carry_on' }) } } });`,
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

  it('refuses "toolResult" as a name it has never heard of, not a seam in waiting', () => {
    // It was reserved until `toolCall` grew an `after` half that sees the call,
    // its arguments, its id and the result. A seam seeing the result alone is
    // strictly less, so the name was dropped rather than built and now means
    // nothing at all.
    expect(
      withComponent({ componentType: 'M', kind: 'middleware', seams: { toolResult: ['after'] } }),
    ).toThrow(/"toolResult", which is not a seam/);
  });

  it('refuses a half the seam does not have', () => {
    expect(
      withComponent({ componentType: 'M', kind: 'middleware', seams: { nodeError: ['before'] } }),
    ).toThrow(/has no such half/);
  });
});

describe('the configuration channel', () => {
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
    const entry = scratch.writeHelperPlugin('cfg-bad', 'serve({});');
    expect(() => chainFrom(RETRY_MANIFEST, entry, { RetryPolicy: { maxAttempts: 'lots' } })).toThrow(
      /maxAttempts/,
    );
  });

  it('refuses a middleware whose required configuration was never supplied', () => {
    const entry = scratch.writeHelperPlugin('cfg-missing', 'serve({});');
    expect(() => chainFrom(RETRY_MANIFEST, entry)).toThrow(
      /configuration for "RetryPolicy".*maxAttempts/s,
    );
  });

  it('refuses configuration no loaded middleware claims', () => {
    const entry = scratch.writeHelperPlugin('cfg-typo', 'serve({});');
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
    const entry = scratch.writeHelperPlugin(
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

  it('reads a model written the way callModel\'s error message asks for it', async () => {
    const entry = scratch.writeHelperPlugin('cfg-llm', 'serve({});');
    const chain = chainFrom(
      {
        ...RETRY_MANIFEST,
        components: [{ ...RETRY_MANIFEST.components[0], schema: undefined }],
      },
      entry,
      { RetryPolicy: { model: { provider: 'openai', model: 'gpt-4o-mini' } } },
    );

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

describe('what a middleware is not asked about', () => {
  it('does not consult the chain when the run was aborted', async () => {
    const ac = new AbortController();
    let consulted = 0;

    const aborting: CompiledNode = {
      name: 'work',
      type: 'tool',
      spec: stepSpec(),
      executor: {
        async execute(): Promise<State> {
          ac.abort();
          throw new Error('execution aborted');
        },
        branch: () => '',
      },
      edges: [{ from: 'work', to: 'done' }],
      inputMappings: new Map(),
    };
    const graph = new CompiledGraph(
      'aborting',
      new Map([['work', aborting]]),
      'work',
    );

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
    const branching: CompiledNode = {
      name: 'route',
      type: 'switch',
      spec: stepSpec(),
      executor: {
        async execute(): Promise<State> {
          throw new Error('route has no value to branch on');
        },
        branch: () => '',
      },
      edges: [
        { from: 'route', branch: 'ok', to: 'end_ok' },
        { from: 'route', branch: 'blocked', to: 'end_blocked' },
      ],
      inputMappings: new Map(),
    };
    const ends = ['end_ok', 'end_blocked'].map((name): [string, CompiledNode] => [
      name,
      {
        name,
        type: 'outcome',
        spec: outcomeSpec(name),
        executor: { execute: async () => new State({}), branch: () => '' },
        edges: [],
        inputMappings: new Map(),
      },
    ]);
    const graph = new CompiledGraph(
      'branching',
      new Map<string, CompiledNode>([['route', branching], ...ends]),
      'route',
    );

    const { error } = await runWith(
      graph,
      chainOf(middleware('Fallback', () => ({ action: 'replace', value: { ok: true } }))),
    );

    expect(error?.message).toMatch(/middleware "Fallback" supplied a result/);
    expect(error?.message).toMatch(/supplies a result, never a route/);
    expect(error?.message).toMatch(/route has no value to branch on/);
  });

  it('refuses an in-process subscription the manifest path would have refused', () => {
    expect(() =>
      chainOf({
        componentType: 'NoSuchSeam',
        // Cast because it is not a `Seam` any more: that is the compile-time
        // half of what this asserts at run time.
        seams: { toolResult: ['after'] } as PluginMiddlewareDef['seams'],
        createMiddleware: () => ({ after: () => ({ action: 'pass' }) }),
      }),
    ).toThrow(/which is not a seam/);

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
});

describe('a document that names a middleware', () => {
  it('is refused with the reason, rather than as an unknown component type', () => {
    const registry = PluginRegistry.fromPlugins([
      pluginWith(middleware('RetryPolicy', () => ({ action: 'pass' }))),
    ]);

    const spec = JSON.stringify({
      weave: 1,
      name: 'f',
      inputs: { q: 'string' },
      steps: [{ name: 'policy', use: 'RetryPolicy' }],
    });

    expect(() => parseFlow(spec, registry)).toThrow(
      /as a middleware rather than a node/,
    );
  });

  it('is not offered as a component type a document could use', () => {
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

describe('an out-of-process middleware', () => {
  const MANIFEST = {
    name: 'resilience',
    version: '1.0.0',
    capabilities: [],
    components: [
      { componentType: 'RetryPolicy', kind: 'middleware', seams: { nodeError: ['after'] } },
    ],
  };

  it('retries a node from another process', async () => {
    const entry = scratch.writeHelperPlugin(
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
    const entry = scratch.writeHelperPlugin(
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
      expect(state?.get('admits')).toEqual(['pass', 'replace', 'retry', 'fail']);
      expect(state?.get('config')).toEqual({ note: 'hello' });
    } finally {
      registry.dispose();
    }
  });

  it('reports a middleware that declares a seam but implements no handler', async () => {
    const entry = scratch.writeHelperPlugin('remote-empty', `serve({ RetryPolicy: {} });`);
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
    const entry = scratch.writeHelperPlugin(
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

describe('a flow compiled alongside middleware', () => {
  it('runs exactly as it would without one, when nothing fails', async () => {
    const spec = JSON.stringify({
      weave: 1,
      name: 'simple',
      inputs: { input: 'string' },
      steps: [
        { name: 'route', switch: '{{inputs.input}}', cases: {}, else: 'done' },
      ],
      outcomes: { done: { input: '{{inputs.input}}' } },
    });

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
