/**
 * Dynamic tool discovery — the one place heddle starts a plugin to learn what it
 * provides.
 *
 * Everything else about a plugin is data: heddle reads a manifest and knows what
 * a flow may name, which is what makes `heddle validate` free and lets a spec be
 * inspected without executing its author's code. An MCP proxy cannot honour
 * that, because the tool list belongs to the server it fronts.
 *
 * So the exception is bought rather than granted, and both halves are pinned
 * here: a manifest asking for discovery does not get it, and an operator opting
 * in does. What must never regress is the property in between — loading is still
 * free, and discovery is a separate step somebody took.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPlugins } from '../loader.js';
import { discoverTools, loadRemotePlugin } from '../remote-loader.js';
import { validateManifest } from '../manifest.js';
import { withRuntime } from '../runtime-source.js';
import type { PluginRegistry } from '../registry.js';

let scratch: string;
const open: PluginRegistry[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-discovery-'));
});

afterEach(() => {
  while (open.length) open.pop()!.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Write a plugin whose tools are answered rather than declared.
 *
 * The entry point is named for the manifest, because that is how `entryFor`
 * finds one when a manifest names no `command`.
 */
function writePlugin(source: string, manifest: Record<string, unknown>): string {
  writeFileSync(join(scratch, 'proxy.mjs'), withRuntime(source));
  const path = join(scratch, 'proxy.json');
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

const PROXY = {
  name: 'mcp-proxy',
  version: '1.0.0',
  capabilities: [],
  discoverTools: true,
  components: [{ componentType: 'Proxy', kind: 'component' }],
};

const SERVES_TWO = `serve({ Proxy: {} }, {
  listTools: async () => ({ tools: [
    { name: 'search', componentType: 'Proxy', description: 'search the corpus' },
    { name: 'fetch', componentType: 'Proxy' },
  ] }),
});`;

describe('the manifest half', () => {
  it('lets a plugin declare nothing but a promise to answer', () => {
    // The shape an MCP proxy has: no components worth naming, no static tools,
    // and a tool list that belongs to the server it fronts. Refusing this for
    // "declares no components and no tools" would make the feature unreachable.
    const manifest = validateManifest({
      name: 'p',
      version: '1.0.0',
      discoverTools: true,
    });

    expect(manifest.discoverTools).toBe(true);
    expect(manifest.tools).toEqual([]);
  });

  it('still refuses a plugin that provides nothing at all', () => {
    expect(() => validateManifest({ name: 'p', version: '1.0.0' })).toThrow(
      /declares no components and no tools/,
    );
  });

  it('points a plugin with nothing to declare at the right field', () => {
    expect(() => validateManifest({ name: 'p', version: '1.0.0' })).toThrow(
      /"discoverTools": true/,
    );
  });

  it('refuses a discoverTools that is not a boolean', () => {
    expect(() =>
      validateManifest({ name: 'p', version: '1.0.0', discoverTools: 'yes' }),
    ).toThrow(/"discoverTools" that is not a boolean/);
  });
});

describe('who may start a plugin', () => {
  it('refuses to start one because its manifest asked', async () => {
    const path = writePlugin(SERVES_TWO, PROXY);

    // The invariant the whole feature is bounded by. A manifest saying "start
    // me" is not consent — reading a manifest runs nothing, and that property is
    // the operator's to spend.
    await expect(loadPlugins([path])).rejects.toThrow(/--discover-tools/);
  });

  it('names the plugin and what it declared', async () => {
    const path = writePlugin(SERVES_TWO, PROXY);

    await expect(loadPlugins([path])).rejects.toThrow(/"mcp-proxy".*discoverTools/s);
  });

  it('starts it and takes the answer once the operator opts in', async () => {
    const path = writePlugin(SERVES_TWO, PROXY);

    const registry = await loadPlugins([path], true);
    open.push(registry);

    expect(registry.toolRegistry().all().map((t) => t.name).sort()).toEqual([
      'fetch',
      'search',
    ]);
    // The description came from the plugin, not from a file heddle read.
    expect(registry.toolRegistry().lookup('search')?.description).toBe(
      'search the corpus',
    );
  });

  it('leaves a plugin that declares no discovery entirely alone', async () => {
    const path = writePlugin(SERVES_TWO, {
      ...PROXY,
      discoverTools: false,
      tools: [{ name: 'declared', componentType: 'Proxy' }],
    });

    // Opting in does not mean asking everybody: discovery is per plugin, and one
    // that did not declare it is never called even with the flag on.
    const registry = await loadPlugins([path], true);
    open.push(registry);

    expect(registry.toolRegistry().all().map((t) => t.name)).toEqual(['declared']);
  });
});

describe('what a plugin may answer', () => {
  const load = async (source: string, manifest = PROXY) => {
    const path = writePlugin(source, manifest);
    const registry = await loadPlugins([path], true);
    open.push(registry);
    return registry;
  };

  it('accepts an empty list, which is not the same as not answering', async () => {
    const registry = await load(
      `serve({ Proxy: {} }, { listTools: async () => ({ tools: [] }) });`,
    );

    expect(registry.toolRegistry().all()).toEqual([]);
  });

  it('adds discovered tools to the ones the manifest declared', async () => {
    const path = writePlugin(SERVES_TWO, {
      ...PROXY,
      tools: [{ name: 'declared', componentType: 'Proxy' }],
    });
    const registry = await loadPlugins([path], true);
    open.push(registry);

    expect(registry.toolRegistry().all().map((t) => t.name).sort()).toEqual([
      'declared',
      'fetch',
      'search',
    ]);
  });

  it('refuses a discovered name the manifest already declared', async () => {
    const path = writePlugin(
      `serve({ Proxy: {} }, { listTools: async () => ({ tools: [
         { name: 'declared', componentType: 'Proxy' },
       ] }) });`,
      { ...PROXY, tools: [{ name: 'declared', componentType: 'Proxy' }] },
    );

    // Caught as the duplicate it is, naming the tool — rather than reaching the
    // registry and being reported as two plugins colliding, which is not what
    // happened.
    await expect(loadPlugins([path], true)).rejects.toThrow(/declared/);
  });

  it('holds a discovered tool to the same rules a declared one meets', async () => {
    const path = writePlugin(
      `serve({ Proxy: {} }, { listTools: async () => ({ tools: [
         { name: 'not a valid name', componentType: 'Proxy' },
       ] }) });`,
      PROXY,
    );

    // A discovered tool is a manifest tool that arrived late. Anything weaker
    // would make discovery a way around the validator rather than an input to
    // it — and this list came out of a process.
    await expect(loadPlugins([path], true)).rejects.toThrow(/name/);
  });

  it('refuses a tool naming a component the plugin does not provide', async () => {
    const path = writePlugin(
      `serve({ Proxy: {} }, { listTools: async () => ({ tools: [
         { name: 'search', componentType: 'Nonexistent' },
       ] }) });`,
      PROXY,
    );

    await expect(loadPlugins([path], true)).rejects.toThrow(/Nonexistent/);
  });

  it('refuses an answer that is not a tool list', async () => {
    const path = writePlugin(
      `serve({ Proxy: {} }, { listTools: async () => ({ nope: true }) });`,
      PROXY,
    );

    await expect(loadPlugins([path], true)).rejects.toThrow(/no "tools"/);
  });

  it('reports a plugin that declared discovery but serves no handler', async () => {
    const path = writePlugin(`serve({ Proxy: {} });`, PROXY);

    await expect(loadPlugins([path], true)).rejects.toThrow(
      /serves no listTools handler/,
    );
  });
});

describe('the property discovery spends, and no more', () => {
  it('starts nothing when it is only loaded', () => {
    const path = writePlugin(SERVES_TWO, PROXY);
    const remote = loadRemotePlugin(
      JSON.parse(readFileSync(path, 'utf-8')),
      join(scratch, 'proxy.mjs'),
      { timeout: 5000 },
    );

    // `loadRemotePlugin` is still a function that reads data. This is what keeps
    // `heddle validate` free, and it is why discovery is a separate awaited step
    // rather than something the loader does when a manifest asks.
    expect(remote.plugin.tools).toEqual([]);
    remote.host.dispose();
  });

  it('asks once, and the answer is the registry\'s for its lifetime', async () => {
    // A counter in the plugin, reported through the tool names it returns, so a
    // second call would be visible as a different list.
    const path = writePlugin(
      `let calls = 0;
       serve({ Proxy: {} }, { listTools: async () => {
         calls++;
         return { tools: [{ name: 'called_' + calls, componentType: 'Proxy' }] };
       } });`,
      PROXY,
    );

    const registry = await loadPlugins([path], true);
    open.push(registry);

    registry.toolRegistry().all();
    registry.toolRegistry().lookup('called_1');
    expect(registry.toolRegistry().all().map((t) => t.name)).toEqual(['called_1']);
  });

  it('keeps lookup synchronous, which three call sites depend on', async () => {
    const path = writePlugin(SERVES_TWO, PROXY);
    const registry = await loadPlugins([path], true);
    open.push(registry);

    // Not a promise. Discovery happens before the registry is built rather than
    // inside it, so resolving a tool name during execution never waits on a pipe.
    const found = registry.toolRegistry().lookup('search');
    expect(found).toBeDefined();
    expect(found).not.toBeInstanceOf(Promise);
  });
});
