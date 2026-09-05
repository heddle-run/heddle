/**
 * `checkPortability`: the definition of record for "runs without a process".
 *
 * The plugin-entry half changed shape when the linker arrived — module syntax
 * used to be a flat refusal, and is now judged by the same `linkEntry` walk a
 * portable host evaluates with. These tests hold the seam: a linkable
 * multi-file entry is portable, an unlinkable one carries the linker's
 * reason, and a host that gives the check no way to read sibling files still
 * gets the conservative answer.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateManifest } from '../../plugin/manifest.js';
import { bundlePortability, type OpenedBundle } from '../open.js';
import { checkPortability, type PortablePluginInput } from '../portable.js';
import type { BundleManifest } from '../format.js';

function bundleManifest(over: Partial<BundleManifest> = {}): BundleManifest {
  return {
    format: 1,
    name: 'demo',
    flow: 'flow.yaml',
    plugins: [],
    pluginConfig: {},
    mounts: [],
    ...over,
  };
}

function jsPlugin(over: {
  entrySource?: string;
  readFile?: (path: string) => string | null;
  manifest?: Record<string, unknown>;
}): PortablePluginInput {
  return {
    manifest: validateManifest({
      name: 'demo-plugin',
      version: '1.0.0',
      capabilities: [],
      components: [{ componentType: 'Demo' }],
      ...over.manifest,
    }),
    entry: 'plugin.mjs',
    entrySource: over.entrySource ?? 'serve({});',
    readFile: over.readFile,
  };
}

describe('bundle-level blockers', () => {
  it('accepts a plain manifest with an import-free plugin', () => {
    const report = checkPortability(bundleManifest(), [jsPlugin({})]);
    expect(report).toEqual({ portable: true, reasons: [] });
  });

  it('refuses tools, mounts, and machine requirements, all at once', () => {
    const report = checkPortability(
      bundleManifest({
        tools: 'tools',
        mounts: [{ path: 'data', dest: 'data', mode: 'ro' }],
        requires: [{ binary: ['python3'] }],
      }),
      [],
    );
    expect(report.portable).toBe(false);
    expect(report.reasons).toHaveLength(3);
  });
});

describe('plugin entries that import sibling modules', () => {
  it('is portable when the linker can walk the graph', () => {
    const report = checkPortability(bundleManifest(), [
      jsPlugin({
        entrySource: `import { handlers } from './handlers.js';\nserve(handlers);`,
        readFile: (path) =>
          path === 'handlers.js' ? 'export const handlers = {};' : null,
      }),
    ]);
    expect(report).toEqual({ portable: true, reasons: [] });
  });

  it('carries the linker problem when the graph cannot be walked', () => {
    const report = checkPortability(bundleManifest(), [
      jsPlugin({
        entrySource: `import fs from 'node:fs';\nserve({});`,
        readFile: () => null,
      }),
    ]);
    expect(report.portable).toBe(false);
    expect(report.reasons[0]).toMatch(
      /plugin "demo-plugin": the entry imports "node:fs"/,
    );
  });

  it('refuses a missing sibling by name', () => {
    const report = checkPortability(bundleManifest(), [
      jsPlugin({
        entrySource: `import { x } from './gone.js';\nserve({});`,
        readFile: () => null,
      }),
    ]);
    expect(report.reasons[0]).toMatch(/"gone\.js", which is not a file/);
  });

  it('answers conservatively when the host cannot read sibling files', () => {
    const report = checkPortability(bundleManifest(), [
      jsPlugin({
        entrySource: `import { handlers } from './handlers.js';\nserve(handlers);`,
      }),
    ]);
    expect(report.portable).toBe(false);
    expect(report.reasons[0]).toMatch(/cannot read them to link/);
  });

  it('never runs the linker over an import-free entry', () => {
    const report = checkPortability(bundleManifest(), [
      jsPlugin({
        entrySource: 'serve({});',
        readFile: () => {
          throw new Error('should not be read');
        },
      }),
    ]);
    expect(report.portable).toBe(true);
  });
});

describe('bundlePortability, reading a plugin from disk', () => {
  let dir = '';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'heddle-portable-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** An OpenedBundle over `dir`, with one plugin written on real disk. */
  function openedWith(entrySource: string, siblings: Record<string, string>) {
    const pluginDir = join(dir, 'plugins', 'modular');
    mkdirSync(join(pluginDir, 'lib'), { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'modular',
        version: '1.0.0',
        capabilities: [],
        components: [{ componentType: 'M' }],
      }),
    );
    writeFileSync(join(pluginDir, 'plugin.mjs'), entrySource);
    for (const [path, source] of Object.entries(siblings)) {
      writeFileSync(join(pluginDir, ...path.split('/')), source);
    }

    return {
      name: 'demo',
      flowPath: join(dir, 'flow.yaml'),
      plugins: [join(pluginDir, 'plugin.json')],
      pluginConfig: {},
      mounts: [],
      requires: [],
      manifest: bundleManifest({ plugins: ['plugins/modular/plugin.json'] }),
      dir,
      dispose: () => {},
    } satisfies OpenedBundle;
  }

  it('links a multi-file entry through the plugin directory', () => {
    const bundle = openedWith(
      `import { handlers } from './lib/handlers.mjs';\nserve(handlers);`,
      { 'lib/handlers.mjs': `export const handlers = {};` },
    );
    expect(bundlePortability(bundle)).toEqual({ portable: true, reasons: [] });
  });

  it('reports what the entry imports and cannot have', () => {
    const bundle = openedWith(
      `import missing from './lib/gone.mjs';\nserve({});`,
      {},
    );
    const report = bundlePortability(bundle);
    expect(report.portable).toBe(false);
    expect(report.reasons[0]).toMatch(/"lib\/gone\.mjs", which is not a file/);
  });
});

describe('the plugin blockers that predate the linker', () => {
  it('still refuses commands, files, discovery, and executable tools', () => {
    const report = checkPortability(bundleManifest(), [
      jsPlugin({
        manifest: {
          command: ['python3', 'main.py'],
          components: [{ componentType: 'Demo' }],
          discoverTools: true,
          files: [{ path: 'seed.txt' }],
          tools: [{ name: 'runner', path: 'bin/run' }],
        },
      }),
    ]);
    expect(report.portable).toBe(false);
    expect(report.reasons.length).toBeGreaterThanOrEqual(4);
  });
});
