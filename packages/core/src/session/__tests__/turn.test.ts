import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '../file-store.js';
import { closeTurn, historyFromTurns, openTurn } from '../turn.js';
import { CHAT_HISTORY_KEY } from '../reserved.js';
import { SessionError } from '../../errors.js';
import type { Checkpoint, Turn } from '../types.js';

let root: string;
let store: FileSessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'heddle-turns-'));
  store = new FileSessionStore({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CHECKPOINT: Checkpoint = {
  runId: 'run-1',
  at: '2026-08-01T00:00:00.000Z',
  node: 'agent',
  carried: {},
  nodeOutputs: {},
  attempt: 1,
  input: { query: 'hello' },
};

describe('a turn against a session', () => {
  it('gives a first turn no history at all', async () => {
    const opened = await openTurn(store, 's1', { query: 'hello' });

    expect(opened.version).toBe(0);
    expect(opened.history).toEqual([]);
    expect(opened.inputs).toEqual({ query: 'hello' });
    expect(CHAT_HISTORY_KEY in opened.inputs).toBe(false);
  });

  it('carries the conversation into the next run', async () => {
    const first = await openTurn(store, 's1', { query: 'who are you' });
    await closeTurn(store, 's1', first, { output: { result: 'a bot' } });

    const second = await openTurn(store, 's1', { query: 'and me?' });

    expect(second.version).toBe(1);
    expect(second.inputs[CHAT_HISTORY_KEY]).toEqual([
      { role: 'user', content: JSON.stringify({ query: 'who are you' }) },
      { role: 'assistant', content: 'a bot' },
    ]);
    // The recorded input stays what the caller passed.
    expect(second.input).toEqual({ query: 'and me?' });
  });

  it('appends under the version the turn was opened at', async () => {
    const opened = await openTurn(store, 's1', { query: 'hi' });
    expect(await closeTurn(store, 's1', opened, { output: { result: 'yo' } })).toBe(1);

    const record = await store.read('s1');
    expect(record?.turns[0]).toMatchObject({
      runId: opened.runId,
      input: { query: 'hi' },
      output: { result: 'yo' },
    });
  });

  it('keeps the history it injected out of the answer it records', async () => {
    const first = await openTurn(store, 's1', { query: 'one' });
    await closeTurn(store, 's1', first, { output: { result: 'a' } });

    // A flow that passes its state through hands the injected history straight
    // back out. Recorded, turn three would quote turn two quoting turn one.
    const second = await openTurn(store, 's1', { query: 'two' });
    await closeTurn(store, 's1', second, {
      output: { result: 'b', ...second.inputs },
    });

    const stored = (await store.read('s1'))?.turns[1].output;
    expect(stored).toEqual({ result: 'b', query: 'two' });
    expect(JSON.stringify(stored)).not.toContain(CHAT_HISTORY_KEY);
  });

  it('keeps a resume payload out of the answer too', async () => {
    const opened = await openTurn(store, 's1', { query: 'one' });
    await closeTurn(store, 's1', opened, {
      output: { result: 'a', _resume: { node: 'agent', bookmark: {}, answer: {} } },
    });

    expect((await store.read('s1'))?.turns[0].output).toEqual({ result: 'a' });
  });

  it('records a failed turn but keeps it out of the conversation', async () => {
    const first = await openTurn(store, 's1', { query: 'boom' });
    await closeTurn(store, 's1', first, {
      error: { name: 'RunError', message: 'the tool exploded' },
    });

    const second = await openTurn(store, 's1', { query: 'again' });

    expect(second.version).toBe(1);
    expect(second.history).toEqual([]);
    expect((await store.read('s1'))?.turns[0].error?.message).toBe(
      'the tool exploded',
    );
  });

  it('refuses a new message while a run is unfinished', async () => {
    await store.writeCheckpoint('s1', CHECKPOINT);

    await expect(openTurn(store, 's1', { query: 'hi' })).rejects.toThrow(
      /has an unfinished run in it/,
    );
  });

  it('says a suspended session wants an answer, not a question', async () => {
    await store.writeCheckpoint('s1', {
      ...CHECKPOINT,
      suspension: {
        by: 'Approval',
        seam: 'toolCall',
        ask: { tool: 'refund' },
        node: 'agent',
        resume: {},
      },
    });

    await expect(openTurn(store, 's1', { query: 'hi' })).rejects.toThrow(
      /waiting on an answer/,
    );
  });

  it('refuses a caller that brought its own history to a session', async () => {
    await expect(
      openTurn(store, 's1', {
        query: 'hi',
        [CHAT_HISTORY_KEY]: [{ role: 'user', content: 'earlier' }],
      }),
    ).rejects.toThrow(SessionError);
  });

  it('renders the user side the way the agent renders its own turn', () => {
    const turns: Turn[] = [
      {
        runId: 'r1',
        at: '2026-08-01T00:00:00.000Z',
        input: { query: 'hi', locale: 'en' },
        output: { result: 'hello' },
      },
    ];

    expect(historyFromTurns(turns)).toEqual([
      { role: 'user', content: JSON.stringify({ query: 'hi', locale: 'en' }) },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('serializes an answer that was not a plain string', () => {
    const turns: Turn[] = [
      {
        runId: 'r1',
        at: '2026-08-01T00:00:00.000Z',
        input: { query: 'count' },
        output: { total: 3 },
      },
    ];

    expect(historyFromTurns(turns)[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify({ total: 3 }),
    });
  });
});
