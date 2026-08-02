import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { loadPlugins } from '../loader.js';
import { PluginRegistry } from '../registry.js';
import { validateManifest } from '../manifest.js';
import { definePlugin } from '../types.js';
import { SessionConflictError, PluginError } from '../../errors.js';
import { closeTurn, openTurn } from '../../session/turn.js';
import type { SessionStore } from '../../session/store.js';
import type { Checkpoint, Turn } from '../../session/types.js';

const repoRoot = join(import.meta.dirname, '../../../../..');
const SQLITE_STORE = join(repoRoot, 'examples/session-store/store.json');
const MEMORY_STORE = join(import.meta.dirname, 'fixtures/memory-store.json');

/**
 * Whether this Node can run the SQLite example.
 *
 * `node:sqlite` arrived in 22.5 and this repo supports 18, so the example is
 * not runnable everywhere — CI is on 20. The protocol tests below use a
 * fixture with no such requirement, so what is skipped here is the example's
 * own smoke test rather than any coverage of the store contract.
 */
const hasNodeSqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

const loaded: PluginRegistry[] = [];

afterEach(() => {
  for (const registry of loaded) registry.dispose();
  loaded.length = 0;
});

async function storeFrom(
  manifest: string,
  componentType: string,
  config: Record<string, unknown> = {},
): Promise<SessionStore> {
  const registry = await loadPlugins([manifest], {});
  loaded.push(registry);

  const store = registry.createStore(componentType, config);
  expect(store).toBeDefined();
  return store as SessionStore;
}

/** The dependency-free fixture. Runs on every Node this repo supports. */
function remoteStore(): Promise<SessionStore> {
  return storeFrom(MEMORY_STORE, 'MemorySessionStore');
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    runId: 'run-1',
    at: '2026-08-01T00:00:00.000Z',
    input: { query: 'hello' },
    output: { result: 'hi' },
    ...overrides,
  };
}

const CHECKPOINT: Checkpoint = {
  runId: 'run-1',
  at: '2026-08-01T00:00:00.000Z',
  node: 'agent',
  carried: { query: 'hello' },
  nodeOutputs: {},
  attempt: 1,
  input: { query: 'hello' },
};

describe('the store manifest kind', () => {
  it('is a kind heddle accepts', () => {
    const manifest = validateManifest({
      name: 'p',
      version: '1.0.0',
      components: [{ componentType: 'MyStore', kind: 'store' }],
    });

    expect(manifest.components[0].kind).toBe('store');
  });

  it('refuses a store that declares a field belonging to another kind', () => {
    for (const extra of [
      { phase: 'pre' },
      { stream: true },
      { protocol: 'ag-ui' },
      { seams: { node: ['after'] } },
    ]) {
      expect(() =>
        validateManifest({
          name: 'p',
          version: '1.0.0',
          components: [
            { componentType: 'MyStore', kind: 'store', ...extra },
          ],
        }),
      ).toThrow(PluginError);
    }
  });

  it('is not a kind a spec can name', async () => {
    const registry = PluginRegistry.fromPlugins([
      definePlugin({
        name: 'p',
        version: '1.0.0',
        stores: [
          { componentType: 'MyStore', createStore: () => ({}) as SessionStore },
        ],
      }),
    ]);

    expect(registry.componentTypeNames()).not.toContain('MyStore');
    expect(registry.createStore('MyStore')).toBeDefined();
    expect(registry.kindOf('MyStore')).toBe('store');
  });

  it('refuses two installed stores, naming both', () => {
    const withStore = (name: string, componentType: string) =>
      definePlugin({
        name,
        version: '1.0.0',
        stores: [
          { componentType, createStore: () => ({}) as SessionStore },
        ],
      });

    expect(() =>
      PluginRegistry.fromPlugins([
        withStore('one', 'StoreA'),
        withStore('two', 'StoreB'),
      ]),
    ).toThrow(/both provide a session store \("StoreA" and "StoreB"\)/);
  });

  it('builds nothing until somebody asks for the store', () => {
    let built = 0;
    const registry = PluginRegistry.fromPlugins([
      definePlugin({
        name: 'p',
        version: '1.0.0',
        stores: [
          {
            componentType: 'MyStore',
            createStore: () => {
              built++;
              return {} as SessionStore;
            },
          },
        ],
      }),
    ]);

    expect(built).toBe(0);
    registry.createStore('MyStore');
    expect(built).toBe(1);
    expect(registry.createStore('Nope')).toBeUndefined();
  });
});

describe('a store in another process', () => {
  it('holds a conversation across the boundary', async () => {
    const store = await remoteStore();

    await store.create('s1', { flow: 'flows/support.yaml' });
    expect(await store.append('s1', turn(), 0)).toBe(1);

    const record = await store.read('s1');
    expect(record).toMatchObject({
      id: 's1',
      flow: 'flows/support.yaml',
      version: 1,
    });
    expect(record?.turns[0].output).toEqual({ result: 'hi' });
  }, 30_000);

  it('answers an unknown session with absence, not a failure', async () => {
    const store = await remoteStore();

    expect(await store.read('never')).toBeUndefined();
    expect(await store.readCheckpoint('never')).toBeUndefined();
    expect(await store.list()).toEqual([]);
  }, 30_000);

  it('rebuilds a conflict as the error the caller catches', async () => {
    const store = await remoteStore();
    await store.append('s1', turn(), 0);

    await expect(store.append('s1', turn(), 0)).rejects.toThrow(
      SessionConflictError,
    );
    await expect(store.append('s1', turn(), 0)).rejects.toThrow(
      /expected version 0, found 1/,
    );
  }, 30_000);

  it('keeps the checkpoint off the transcript', async () => {
    const store = await remoteStore();
    await store.append('s1', turn(), 0);
    await store.writeCheckpoint('s1', CHECKPOINT);

    expect(await store.readCheckpoint('s1')).toMatchObject({ node: 'agent' });
    expect((await store.read('s1'))?.version).toBe(1);

    await store.writeCheckpoint('s1', null);
    expect(await store.readCheckpoint('s1')).toBeUndefined();
  }, 30_000);

  it('lists and deletes', async () => {
    const store = await remoteStore();
    await store.append('s1', turn(), 0);
    await store.writeCheckpoint('s2', CHECKPOINT);

    const listed = await store.list();
    expect(listed.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(listed.find((s) => s.id === 's2')?.unfinished).toBe(true);

    await store.delete('s1');
    expect(await store.read('s1')).toBeUndefined();
  }, 30_000);

  it('serves the same turn layer the file store does', async () => {
    const store = await remoteStore();

    const first = await openTurn(store, 's1', { query: 'who are you' });
    await closeTurn(store, 's1', first, { output: { result: 'a bot' } });

    const second = await openTurn(store, 's1', { query: 'and me?' });
    expect(second.version).toBe(1);
    expect(second.history).toEqual([
      { role: 'user', content: JSON.stringify({ query: 'who are you' }) },
      { role: 'assistant', content: 'a bot' },
    ]);
  }, 30_000);

  it('refuses configuration its manifest schema does not describe', async () => {
    const registry = await loadPlugins([MEMORY_STORE], {});
    loaded.push(registry);

    // Checked before anything is spawned: a manifest is data, so a bad setting
    // is caught without starting the store's process.
    expect(() =>
      registry.createStore('MemorySessionStore', { label: 42 }),
    ).toThrow(PluginError);
  }, 30_000);

  it('carries the store its own configuration on every call', async () => {
    // There is no verb that constructs a store, so its settings ride along.
    const store = await storeFrom(MEMORY_STORE, 'MemorySessionStore', {
      label: 'from-plugin-config',
    });
    await store.create('s1');

    expect((await store.read('s1'))?.flow).toBe('from-plugin-config');
  }, 30_000);
});

/**
 * The shipped SQLite example, where the Node running the tests can load it.
 *
 * `node:sqlite` arrived in Node 22.5 and this repo supports 18, so this is the
 * one part of the store suite that cannot run everywhere. The contract itself
 * is covered above by a fixture with no such requirement — what is skipped here
 * is whether the *example* works, not whether stores do.
 */
describe.skipIf(!hasNodeSqlite)('the shipped SQLite store', () => {
  it('holds a conversation, and reports a conflict as a result', async () => {
    const store = await storeFrom(SQLITE_STORE, 'SqliteSessionStore', {
      path: ':memory:',
    });

    await store.create('s1', { flow: 'flows/support.yaml' });
    expect(await store.append('s1', turn(), 0)).toBe(1);
    expect(await store.read('s1')).toMatchObject({ version: 1 });

    await expect(store.append('s1', turn(), 0)).rejects.toThrow(
      SessionConflictError,
    );
  }, 30_000);

  it('keeps the checkpoint off the transcript', async () => {
    const store = await storeFrom(SQLITE_STORE, 'SqliteSessionStore', {
      path: ':memory:',
    });

    await store.append('s1', turn(), 0);
    await store.writeCheckpoint('s1', CHECKPOINT);

    expect(await store.readCheckpoint('s1')).toMatchObject({ node: 'agent' });
    expect((await store.read('s1'))?.version).toBe(1);
  }, 30_000);
});
