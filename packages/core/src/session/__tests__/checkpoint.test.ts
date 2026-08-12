import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompiledGraph,
  type CompiledNode,
  type GraphNodeSpec,
} from '../../graph/types.js';
import { Runner } from '../../runner/runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../../runner/options.js';
import type {
  CheckpointSink,
  RunnerOptions,
  RunPosition,
  SuspensionRecord,
} from '../../runner/options.js';
import { State } from '../../state/state.js';
import { RunError, SessionError } from '../../errors.js';
import { FileSessionStore } from '../file-store.js';
import { checkpointSink, positionOf } from '../checkpoint.js';
import { closeTurn, openTurn, resumeTurn } from '../turn.js';

/** A node that records that it ran, and adds one field to the state. */
function node(
  name: string,
  role: 'inputs' | 'step' | 'outcome',
  toNode: string | undefined,
  ran: string[],
  produce: (input: State) => State = (input) => input,
): [string, CompiledNode] {
  const spec: GraphNodeSpec =
    role === 'inputs'
      ? { role, inputs: {} }
      : role === 'outcome'
        ? { role, outcome: { name } }
        : { role, step: { kind: 'use', name, use: 'Recorder', config: {} } };

  return [
    name,
    {
      name,
      type: role === 'step' ? 'Recorder' : role === 'inputs' ? 'start' : 'outcome',
      spec,
      executor: {
        execute: async (_signal, input: State) => {
          ran.push(name);
          return produce(input);
        },
        branch: () => '',
      },
      edges: toNode ? [{ from: name, to: toNode }] : [],
      inputMappings: new Map(),
    },
  ];
}

/** start -> a -> b -> end, each step adding a field. */
function chain(ran: string[], failAt?: string): CompiledGraph {
  const step = (name: string, next: string) =>
    node(name, 'step', next, ran, (input) => {
      if (name === failAt) throw new RunError(`${name} exploded`);
      return input.set(name, `${name}-done`);
    });

  return new CompiledGraph(
    'chain',
    new Map([
      node('start', 'inputs', 'a', ran),
      step('a', 'b'),
      step('b', 'end'),
      node('end', 'outcome', undefined, ran),
    ]),
    'start',
  );
}

interface Collected extends CheckpointSink {
  saved: RunPosition[];
  suspended: SuspensionRecord[];
  cleared: number;
}

function collectingSink(): Collected {
  const sink: Collected = {
    saved: [],
    suspended: [],
    cleared: 0,
    async save(position: RunPosition) {
      sink.saved.push(structuredClone(position));
    },
    async suspend(position: RunPosition, suspension: SuspensionRecord) {
      sink.saved.push(structuredClone(position));
      sink.suspended.push(structuredClone(suspension));
    },
    async clear() {
      sink.cleared++;
    },
  };
  return sink;
}

/** Durable by default here: these tests are about what gets written down. */
function opts(overrides: Partial<RunnerOptions> = {}): RunnerOptions {
  return { ...DEFAULT_RUNNER_OPTIONS, durable: true, ...overrides };
}

describe('checkpointing a run at node boundaries', () => {
  it('records where to resume, never the node that just ran', async () => {
    const ran: string[] = [];
    const sink = collectingSink();

    await new Runner(chain(ran), opts({ checkpoints: sink })).run(undefined, {
      query: 'hi',
    });

    expect(ran).toEqual(['start', 'a', 'b', 'end']);
    // One per boundary crossed, naming the node about to run.
    expect(sink.saved.map((p) => p.node)).toEqual(['a', 'b', 'end']);
  });

  it('carries the state and the node outputs the walk had accumulated', async () => {
    const sink = collectingSink();
    await new Runner(chain([]), opts({ checkpoints: sink })).run(undefined, {
      query: 'hi',
    });

    const beforeEnd = sink.saved[2];
    expect(beforeEnd.carried).toEqual({
      query: 'hi',
      a: 'a-done',
      b: 'b-done',
    });
    expect(Object.keys(beforeEnd.nodeOutputs).sort()).toEqual(['a', 'b', 'start']);
  });

  it('clears the checkpoint when the run finishes', async () => {
    const sink = collectingSink();
    await new Runner(chain([]), opts({ checkpoints: sink })).run(undefined, {});

    expect(sink.cleared).toBe(1);
  });

  it('leaves the checkpoint behind when the run fails', async () => {
    const sink = collectingSink();

    await expect(
      new Runner(chain([], 'b'), opts({ checkpoints: sink })).run(undefined, {}),
    ).rejects.toThrow(/b exploded/);

    expect(sink.cleared).toBe(0);
    expect(sink.saved.at(-1)?.node).toBe('b');
  });

  it('costs nothing when nothing is checkpointing', async () => {
    const ran: string[] = [];
    const state = await new Runner(chain(ran), opts()).run(undefined, {
      query: 'hi',
    });

    expect(state.get('b')).toBe('b-done');
  });
});

describe('resuming from a checkpoint', () => {
  it('re-enters at the node named and runs nothing before it', async () => {
    const first: string[] = [];
    const sink = collectingSink();
    await expect(
      new Runner(chain(first, 'b'), opts({ checkpoints: sink })).run(
        undefined,
        { query: 'hi' },
      ),
    ).rejects.toThrow();

    expect(first).toEqual(['start', 'a', 'b']);

    const second: string[] = [];
    const state = await new Runner(chain(second), opts()).run(
      undefined,
      {},
      sink.saved.at(-1),
    );

    // "start" and "a" are not re-run: the whole point.
    expect(second).toEqual(['b', 'end']);
    expect(state.get('a')).toBe('a-done');
    expect(state.get('b')).toBe('b-done');
    expect(state.get('query')).toBe('hi');
  });

  it('says the checkpoint is stale when the flow no longer has that node', async () => {
    const stale: RunPosition = {
      node: 'renamed',
      carried: {},
      nodeOutputs: {},
      attempt: 1,
    };

    await expect(
      new Runner(chain([]), opts()).run(undefined, {}, stale),
    ).rejects.toThrow(/checkpoint was written by a run of a different version/);
  });
});

describe('a checkpoint in a session', () => {
  let root: string;
  let store: FileSessionStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'heddle-checkpoint-'));
    store = new FileSessionStore({ root });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('survives the process that wrote it', async () => {
    const opened = await openTurn(store, 's1', { query: 'hi' });
    const sink = checkpointSink({
      store,
      sessionId: 's1',
      runId: opened.runId,
      input: opened.input,
    });

    await expect(
      new Runner(chain([], 'b'), opts({ checkpoints: sink })).run(
        undefined,
        opened.inputs,
      ),
    ).rejects.toThrow();
    await closeTurn(store, 's1', opened, {
      error: { name: 'RunError', message: 'b exploded' },
    });

    // A different process, holding only the session id.
    const resumed = await resumeTurn(new FileSessionStore({ root }), 's1');
    expect(resumed.checkpoint.node).toBe('b');
    expect(resumed.input).toEqual({ query: 'hi' });

    const ran: string[] = [];
    const state = await new Runner(chain(ran), opts()).run(
      undefined,
      resumed.inputs,
      positionOf(resumed.checkpoint),
    );

    expect(ran).toEqual(['b', 'end']);
    expect(state.get('a')).toBe('a-done');
  });

  it('refuses to resume a session that has nothing unfinished', async () => {
    await store.append(
      's1',
      { runId: 'r', at: new Date().toISOString(), input: {}, output: {} },
      0,
    );

    await expect(resumeTurn(store, 's1')).rejects.toThrow(
      /has nothing to resume/,
    );
  });

  it('refuses a state that would not survive being written down', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const sink = checkpointSink({
      store,
      sessionId: 's1',
      runId: 'r1',
      input: {},
    });

    await expect(
      sink.save({ node: 'a', carried: cyclic, nodeOutputs: {}, attempt: 1 }),
    ).rejects.toThrow(SessionError);
    await expect(
      sink.save({ node: 'a', carried: cyclic, nodeOutputs: {}, attempt: 1 }),
    ).rejects.toThrow(/does not survive JSON/);
  });
});
