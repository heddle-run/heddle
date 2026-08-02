/**
 * `suspend` — the verdict that stops a run instead of deciding for it.
 *
 * Every other `before` verdict answers the question the seam asked: proceed,
 * change the arguments, supply a result, refuse. This one says the question is
 * not heddle's to answer, and hands it to a person. What makes that more than a
 * fancy failure is what comes back: the run is written down where it stopped,
 * and resuming re-enters the node with the work it had already done intact.
 *
 * The tests below are mostly about that second half. Suspending is easy;
 * resuming *without repeating anything* is the part that has to be got right,
 * because a tool call made twice is not a slow resume — it is a wrong one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentExecutor } from '../../node/agent.js';
import { MiddlewareChain } from '../middleware.js';
import { State } from '../../state/state.js';
import { CompiledGraph, type CompiledNode } from '../../graph/types.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS, type RunnerOptions } from '../../runner/options.js';
import { FileSessionStore } from '../../session/file-store.js';
import { checkpointSink, positionOf } from '../../session/checkpoint.js';
import { openTurn, resumeTurn } from '../../session/turn.js';
import { resumeInputs, isSuspended, RunSuspended } from '../../session/suspend.js';
import { RunError } from '../../errors.js';
import type { AgentNode } from '../../spec/types.js';
import type { Message, Provider, ToolCall } from '../../llm/types.js';
import type { Dependencies } from '../../node/types.js';
import type { PluginMiddlewareDef } from '../types.js';
import { chainOf } from './helpers/seams.js';

let root: string;
let store: FileSessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'heddle-suspend-'));
  store = new FileSessionStore({ root });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/**
 * Asks for `calls` until it sees them answered, then finishes.
 *
 * Keyed on the conversation rather than on a call counter, because a resumed
 * run gets a *fresh* provider that has never been asked anything — and a
 * counter would have it replay the first round, which no real model shown a
 * conversation full of tool results would do.
 */
function providerAsking(calls: ToolCall[]): {
  provider: Provider;
  seen: () => Message[];
  rounds: () => number;
} {
  let rounds = 0;
  let captured: Message[] = [];

  return {
    seen: () => captured,
    rounds: () => rounds,
    provider: {
      chatCompletion: async (_signal, request) => {
        captured = request.messages;
        rounds++;
        return request.messages.some((message) => message.role === 'tool')
          ? { content: 'all done', finish_reason: 'stop' }
          : { content: '', finish_reason: 'tool_calls', tool_calls: calls };
      },
    },
  };
}

function gateOn(tool: string): PluginMiddlewareDef {
  return {
    componentType: 'ApprovalGate',
    seams: { toolCall: ['before'] },
    createMiddleware: () => ({
      before: ({ subject }) =>
        subject.toolName === tool
          ? { action: 'suspend', ask: { question: `Approve ${tool}?` } }
          : { action: 'proceed' },
      after: () => ({ action: 'pass' }),
    }),
  };
}

interface Built {
  node: CompiledNode;
  ran: string[];
  seen: () => Message[];
  rounds: () => number;
}

function agentNode(
  chain: MiddlewareChain,
  calls: ToolCall[],
  ran: string[],
): Built {
  const { provider, seen, rounds } = providerAsking(calls);

  const deps: Dependencies = {
    middleware: chain,
    createProvider: () => provider,
    toolRegistry: {
      lookup: (name) => ({
        name,
        description: '',
        origin: 'test',
        impl: {
          kind: 'plugin' as const,
          plugin: 'test',
          call: async () => {
            ran.push(name);
            return { output: { ran: name }, stderr: '' };
          },
        },
      }),
      all: () => [],
    },
  };

  const spec = {
    name: 'assistant',
    componentType: 'AgentNode',
    agent: {
      name: 'assistant',
      systemPrompt: 'do the thing',
      llmConfig: { componentType: 'OpenAiConfig', modelId: 'gpt-4o', name: 'llm' },
      tools: calls.map((call) => ({ name: call.name, description: '' })),
      transforms: [],
    },
  } as unknown as AgentNode;

  return {
    node: {
      name: 'assistant',
      type: 'AgentNode',
      specNode: spec as never,
      executor: new AgentExecutor(spec, deps),
      edges: [{ fromNode: 'assistant', toNode: 'end' }],
      inputMappings: new Map(),
    },
    ran,
    seen,
    rounds,
  };
}

function graphWith(node: CompiledNode): CompiledGraph {
  const end: CompiledNode = {
    name: 'end',
    type: 'EndNode',
    specNode: { componentType: 'EndNode', name: 'end' } as never,
    executor: { execute: async (_s, input) => input, branch: () => '' },
    edges: [],
    inputMappings: new Map(),
  };

  return new CompiledGraph(
    'gated',
    new Map([
      ['assistant', node],
      ['end', end],
    ]),
    'assistant',
    [],
  );
}

function opts(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return { ...DEFAULT_RUNNER_OPTIONS, ...overrides };
}

const call = (id: string, name: string): ToolCall => ({
  id,
  name,
  arguments: '{"amount":100}',
});

describe('a suspended tool call', () => {
  it('stops the run without running the tool', async () => {
    const ran: string[] = [];
    const built = agentNode(chainOf(gateOn('refund')), [call('c1', 'refund')], ran);
    const sink = checkpointSink({ store, sessionId: 's1', runId: 'r1', input: {} });

    const failure = await new Runner(graphWith(built.node), opts({ checkpoints: sink }))
      .run(undefined, {})
      .catch((err) => err);

    expect(isSuspended(failure)).toBe(true);
    expect(ran).toEqual([]);
    expect((failure as RunSuspended).suspension.by).toBe('ApprovalGate');
  });

  it('says what is being asked, including the call it is about', async () => {
    const built = agentNode(chainOf(gateOn('refund')), [call('c1', 'refund')], []);
    const sink = checkpointSink({ store, sessionId: 's1', runId: 'r1', input: {} });

    const failure = (await new Runner(
      graphWith(built.node),
      opts({ checkpoints: sink }),
    )
      .run(undefined, {})
      .catch((err) => err)) as RunSuspended;

    // heddle adds the call and its arguments; the middleware added the question.
    expect(failure.suspension.ask).toMatchObject({
      tool: 'refund',
      arguments: { amount: 100 },
      question: 'Approve refund?',
    });
    expect(failure.suspension.node).toBe('assistant');
    expect(failure.suspension.seam).toBe('toolCall');
  });

  it('is written into the session, naming the node to re-enter', async () => {
    const built = agentNode(chainOf(gateOn('refund')), [call('c1', 'refund')], []);
    const opened = await openTurn(store, 's1', { query: 'refund me' });
    const sink = checkpointSink({
      store,
      sessionId: 's1',
      runId: opened.runId,
      input: opened.input,
    });

    await new Runner(graphWith(built.node), opts({ checkpoints: sink }))
      .run(undefined, opened.inputs)
      .catch(() => {});

    const checkpoint = await store.readCheckpoint('s1');
    expect(checkpoint?.node).toBe('assistant');
    expect(checkpoint?.suspension?.by).toBe('ApprovalGate');
    expect(checkpoint?.input).toEqual({ query: 'refund me' });
    // The turn is not closed: the conversation is mid-sentence.
    expect((await store.read('s1'))?.version).toBe(0);
  });

  it('is refused outright when the run has nowhere to be written down', async () => {
    const built = agentNode(chainOf(gateOn('refund')), [call('c1', 'refund')], []);

    await expect(
      new Runner(graphWith(built.node), opts()).run(undefined, {}),
    ).rejects.toThrow(/nowhere to be written down/);
  });

  it('is not reported as a node failure', async () => {
    const events: string[] = [];
    const built = agentNode(chainOf(gateOn('refund')), [call('c1', 'refund')], []);
    const sink = checkpointSink({ store, sessionId: 's1', runId: 'r1', input: {} });

    await new Runner(
      graphWith(built.node),
      opts({ checkpoints: sink, eventHandler: (e) => events.push(e.type) }),
    )
      .run(undefined, {})
      .catch(() => {});

    expect(events).not.toContain('node_error');
  });
});

describe('a node-level suspension', () => {
  /**
   * A gate on one node, which lets it through once it has been answered.
   *
   * Guarding a named node rather than every node, because that is what a real
   * one does — and because an unconditional gate suspends again at the *next*
   * node, correctly: the answer it was given was about a different one.
   */
  function nodeGate(guarded: string): PluginMiddlewareDef {
    return {
      componentType: 'ShipGate',
      seams: { node: ['before'] },
      createMiddleware: () => ({
        before: ({ subject }, ctx) => {
          if (subject.nodeName !== guarded) return { action: 'proceed' };
          return ctx.answered
            ? { action: 'proceed' }
            : { action: 'suspend', ask: { question: 'Ship it?' } };
        },
        after: () => ({ action: 'pass' }),
      }),
    };
  }

  it('lets a gate tell "answered" from "asked again"', async () => {
    const built = agentNode(chainOf(gateOn('none')), [call('c1', 'noop')], []);
    const node = built.node;
    node.executor = { execute: async (_s, input) => input, branch: () => '' };

    const graph = graphWith(node);
    const chain = chainOf(nodeGate('assistant'));
    const sink = checkpointSink({ store, sessionId: 's1', runId: 'r1', input: {} });

    const failure = (await new Runner(graph, opts({ middleware: chain, checkpoints: sink }))
      .run(undefined, { query: 'deploy' })
      .catch((err) => err)) as RunSuspended;

    expect(isSuspended(failure)).toBe(true);
    expect(failure.suspension.ask).toEqual({ question: 'Ship it?' });

    // The same gate, in the same state it would be in on a fresh process: the
    // only thing telling it this was answered is `ctx.answered`.
    const resumed = await resumeTurn(store, 's1');
    const state = await new Runner(
      graphWith(node),
      opts({
        middleware: chainOf(nodeGate('assistant')),
        checkpoints: checkpointSink({ store, sessionId: 's1', runId: 'r1', input: {} }),
      }),
    ).run(
      undefined,
      resumeInputs(resumed.checkpoint.suspension!, { approved: true }),
      positionOf(resumed.checkpoint),
    );

    expect(state.get('query')).toBe('deploy');
    expect(await store.readCheckpoint('s1')).toBeUndefined();
  });
});

describe('resuming a suspended run', () => {
  async function suspendThenResume(
    calls: ToolCall[],
    gatedTool: string,
    answer: Record<string, unknown>,
  ) {
    const firstRun: string[] = [];
    const first = agentNode(chainOf(gateOn(gatedTool)), calls, firstRun);
    const opened = await openTurn(store, 's1', { query: 'go' });
    const sink = checkpointSink({
      store,
      sessionId: 's1',
      runId: opened.runId,
      input: opened.input,
    });

    await new Runner(graphWith(first.node), opts({ checkpoints: sink }))
      .run(undefined, opened.inputs)
      .catch(() => {});

    // A fresh process: a new agent, a new provider, holding only the store.
    const secondRun: string[] = [];
    const second = agentNode(chainOf(gateOn(gatedTool)), calls, secondRun);
    const resumed = await resumeTurn(store, 's1');
    const suspension = resumed.checkpoint.suspension!;

    const state = await new Runner(
      graphWith(second.node),
      opts({
        checkpoints: checkpointSink({
          store,
          sessionId: 's1',
          runId: resumed.runId,
          input: resumed.input,
        }),
      }),
    ).run(
      undefined,
      { ...resumed.inputs, ...resumeInputs(suspension, answer) },
      positionOf(resumed.checkpoint),
    );

    return { state, first, second, firstRun, secondRun };
  }

  it('does not call the model again for the round it stopped in', async () => {
    const { second } = await suspendThenResume(
      [call('c1', 'refund')],
      'refund',
      { approved: true },
    );

    // Round one's response came out of the checkpoint. The only model call this
    // process made is the one that produced the final answer.
    expect(second.rounds()).toBe(1);
    expect(second.seen().some((m) => m.role === 'system')).toBe(true);
  });

  it("hands the human's answer back as the call's result", async () => {
    const { second } = await suspendThenResume(
      [call('c1', 'refund')],
      'refund',
      { approved: true, note: 'ok by finance' },
    );

    const reply = second.seen().find((m) => m.tool_call_id === 'c1');
    expect(reply?.role).toBe('tool');
    expect(JSON.parse(reply?.content ?? '{}')).toEqual({
      approved: true,
      note: 'ok by finance',
    });
  });

  it('never runs the gated tool, before or after', async () => {
    const { firstRun, secondRun } = await suspendThenResume(
      [call('c1', 'refund')],
      'refund',
      { approved: true },
    );

    expect(firstRun).toEqual([]);
    expect(secondRun).toEqual([]);
  });

  it('does not re-run the calls that already succeeded in that round', async () => {
    const { firstRun, secondRun } = await suspendThenResume(
      [call('c1', 'lookup'), call('c2', 'refund')],
      'refund',
      { approved: true },
    );

    // "lookup" ran before the gate stopped "refund", and must not run twice.
    expect(firstRun).toEqual(['lookup']);
    expect(secondRun).toEqual([]);
  });

  it('runs the calls the suspended round never reached', async () => {
    const { firstRun, secondRun, second } = await suspendThenResume(
      [call('c1', 'refund'), call('c2', 'notify')],
      'refund',
      { approved: true },
    );

    expect(firstRun).toEqual([]);
    // "notify" belongs to a model request already in the conversation, so it
    // has to be answered — on the way back, since it was never reached.
    expect(secondRun).toEqual(['notify']);
    expect(second.seen().filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('finishes the run and clears the checkpoint', async () => {
    const { state } = await suspendThenResume(
      [call('c1', 'refund')],
      'refund',
      { approved: true },
    );

    expect(state.get('result')).toBe('all done');
    expect(await store.readCheckpoint('s1')).toBeUndefined();
  });

  it('refuses a bookmark that could not produce a conversation', async () => {
    const built = agentNode(chainOf(gateOn('refund')), [call('c1', 'refund')], []);
    await store.writeCheckpoint('s1', {
      runId: 'r1',
      at: new Date().toISOString(),
      node: 'assistant',
      carried: {},
      nodeOutputs: {},
      attempt: 1,
      input: {},
      suspension: {
        by: 'ApprovalGate',
        seam: 'toolCall',
        ask: {},
        node: 'assistant',
        resume: { round: 1 },
      },
    });

    const resumed = await resumeTurn(store, 's1');

    await expect(
      new Runner(
        graphWith(built.node),
        opts({
          checkpoints: checkpointSink({
            store,
            sessionId: 's1',
            runId: 'r1',
            input: {},
          }),
        }),
      ).run(
        undefined,
        resumeInputs(resumed.checkpoint.suspension!, { approved: true }),
        positionOf(resumed.checkpoint),
      ),
    ).rejects.toThrow(RunError);
  });
});
