import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '../file-store.js';
import { SessionConflictError, SessionError } from '../../errors.js';
import type { Checkpoint, Turn } from '../types.js';

let root: string;
let store: FileSessionStore;

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    runId: 'run-1',
    at: '2026-08-01T00:00:00.000Z',
    input: { query: 'hello' },
    output: { result: 'hi' },
    ...overrides,
  };
}

function checkpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    runId: 'run-1',
    at: '2026-08-01T00:00:00.000Z',
    node: 'agent',
    carried: { query: 'hello' },
    nodeOutputs: { start: { query: 'hello' } },
    attempt: 1,
    input: { query: 'hello' },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'heddle-sessions-'));
  store = new FileSessionStore({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the file session store', () => {
  it('reads an unknown session as absent rather than as an error', async () => {
    expect(await store.read('nope')).toBeUndefined();
    expect(await store.readCheckpoint('nope')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it('creates the session on the first append', async () => {
    expect(await store.append('s1', turn(), 0)).toBe(1);

    const record = await store.read('s1');
    expect(record?.id).toBe('s1');
    expect(record?.version).toBe(1);
    expect(record?.turns).toHaveLength(1);
  });

  it('appends a line per turn instead of rewriting the transcript', async () => {
    await store.append('s1', turn({ runId: 'a' }), 0);
    await store.append('s1', turn({ runId: 'b' }), 1);
    await store.append('s1', turn({ runId: 'c' }), 2);

    const lines = readFileSync(join(root, 's1', 'turns.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean);

    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).runId)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a write whose version has moved on', async () => {
    await store.append('s1', turn(), 0);

    await expect(store.append('s1', turn(), 0)).rejects.toThrow(
      SessionConflictError,
    );
    await expect(store.append('s1', turn(), 0)).rejects.toThrow(
      /expected version 0, found 1/,
    );
  });

  it('keeps the session readable when a turn was half-written', async () => {
    await store.append('s1', turn({ runId: 'whole' }), 0);
    writeFileSync(
      join(root, 's1', 'turns.jsonl'),
      `${JSON.stringify(turn({ runId: 'whole' }))}\n{"runId":"cut`,
    );

    const record = await store.read('s1');
    expect(record?.turns.map((t) => t.runId)).toEqual(['whole']);
    expect(record?.version).toBe(1);
  });

  it('holds the checkpoint beside the transcript, not inside it', async () => {
    await store.append('s1', turn(), 0);
    await store.writeCheckpoint('s1', checkpoint());

    expect(await store.readCheckpoint('s1')).toMatchObject({ node: 'agent' });
    // The transcript is untouched by a checkpoint write.
    expect((await store.read('s1'))?.version).toBe(1);
  });

  it('clears the checkpoint when a run finishes', async () => {
    await store.writeCheckpoint('s1', checkpoint());
    await store.writeCheckpoint('s1', null);

    expect(await store.readCheckpoint('s1')).toBeUndefined();
    expect(existsSync(join(root, 's1', 'checkpoint.json'))).toBe(false);
  });

  it('starts a session from a checkpoint, before it has any turns', async () => {
    await store.writeCheckpoint('s1', checkpoint());

    const record = await store.read('s1');
    expect(record?.version).toBe(0);
    expect(record?.turns).toEqual([]);
  });

  it('lists sessions newest first, saying which are unfinished', async () => {
    await store.append('old', turn(), 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.append('new', turn(), 0);
    await store.writeCheckpoint('new', checkpoint());

    const listed = await store.list();
    expect(listed.map((s) => s.id)).toEqual(['new', 'old']);
    expect(listed[0]).toMatchObject({ turns: 1, unfinished: true });
    expect(listed[1]).toMatchObject({ turns: 1, unfinished: false });
  });

  it('pages a listing from a cursor', async () => {
    for (const id of ['a', 'b', 'c']) {
      await store.append(id, turn(), 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const first = await store.list({ limit: 2 });
    expect(first).toHaveLength(2);

    const rest = await store.list({ cursor: first[1].id });
    expect(rest.map((s) => s.id)).toEqual(['a']);
  });

  it('deletes a session whole', async () => {
    await store.append('s1', turn(), 0);
    await store.writeCheckpoint('s1', checkpoint());
    await store.delete('s1');

    expect(await store.read('s1')).toBeUndefined();
    expect(existsSync(join(root, 's1'))).toBe(false);
  });

  it('deleting a session that never existed is not an error', async () => {
    await expect(store.delete('never')).resolves.toBeUndefined();
  });

  it('records the flow the first turn named', async () => {
    await store.append('s1', turn({ flow: 'flows/support.yaml' }), 0);

    expect((await store.read('s1'))?.flow).toBe('flows/support.yaml');
  });

  it('refuses an id that would escape the root', async () => {
    for (const bad of ['../escape', 'a/b', '.hidden', '', 'has space']) {
      await expect(store.read(bad)).rejects.toThrow(SessionError);
    }
  });
});
