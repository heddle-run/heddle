import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginNode } from '@heddle/core';
import { resolveConfig, DEFAULT_PLUGIN_CALL_TIMEOUT } from '../config.js';
import { materializeRequestCode, type MaterializedCode } from '../request-code.js';
import { buildPlugins } from '../plugins.js';

/**
 * A plugin whose `execute` never settles. The runtime keeps the process alive
 * on its stdin listener, so this is a plugin that is running and answering
 * nothing — the case a per-call budget exists for, and the one a run-length
 * budget cannot tell apart from a plugin doing slow work.
 */
const HANGING_PLUGIN = {
  name: 'hang',
  manifest: {
    name: 'hang',
    version: '1.0.0',
    components: [{ componentType: 'HangNode', kind: 'node' }],
  },
  source: `serve({ HangNode: { execute: () => new Promise(() => {}) } });`,
};

function hangNode(): PluginNode {
  return {
    componentType: 'HangNode',
    name: 'hang',
    id: 'hang',
    metadata: {},
  };
}

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Materialize the hanging plugin and load it, tearing both down afterwards. */
function loadHangingPlugin(pluginCallTimeout: number, timeout: number) {
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-plugin-timeout-'));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));

  const config = resolveConfig({
    allowRequestCode: true,
    pluginCallTimeout,
    timeout,
    workDir,
  });

  const code: MaterializedCode = materializeRequestCode(
    { plugins: [HANGING_PLUGIN] },
    config,
  );
  cleanups.push(() => code.dispose());

  const registry = buildPlugins(config, code);
  cleanups.push(() => registry.dispose());

  const def = registry.nodeDef('HangNode');
  expect(def).toBeDefined();
  return def!.createExecutor(hangNode(), {});
}

describe('per-call plugin budget', () => {
  it('defaults independently of the run budget, so a long run does not widen it', () => {
    expect(resolveConfig({ timeout: 300_000 })).toMatchObject({
      timeout: 300_000,
      pluginCallTimeout: DEFAULT_PLUGIN_CALL_TIMEOUT,
    });
    expect(resolveConfig({ timeout: 3_600_000 })).toMatchObject({
      timeout: 3_600_000,
      pluginCallTimeout: DEFAULT_PLUGIN_CALL_TIMEOUT,
    });
  });

  it('is settable on its own', () => {
    expect(resolveConfig({ pluginCallTimeout: 5_000 })).toMatchObject({
      pluginCallTimeout: 5_000,
      timeout: 300_000,
    });
  });

  it('bounds a call that never answers, well inside the run budget', async () => {
    const executor = loadHangingPlugin(300, 300_000);

    const started = Date.now();
    await expect(
      executor.execute({}, { signal: undefined, node: hangNode(), runTool: async () => ({}) }),
    ).rejects.toThrow(/did not answer execute within 300ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('never exceeds the run budget, however it was configured', async () => {
    // The default is a tightening for a five-minute run budget and a loosening
    // for anything shorter, and an operator who lowers --timeout to shed load
    // is doing the opposite of asking for a longer plugin call. What makes the
    // clamp necessary rather than tidy: the run's deadline cannot end a pending
    // plugin call by itself, so whichever bound is larger is the one that
    // decides how long a concurrency slot stays held.
    const executor = loadHangingPlugin(30_000, 300);

    const started = Date.now();
    await expect(
      executor.execute({}, { signal: undefined, node: hangNode(), runTool: async () => ({}) }),
    ).rejects.toThrow(/did not answer execute within 300ms/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills the plugin, so a second call does not wait on a channel it cannot trust', async () => {
    const executor = loadHangingPlugin(300, 300_000);
    const ctx = { signal: undefined, node: hangNode(), runTool: async () => ({}) };

    await expect(executor.execute({}, ctx)).rejects.toThrow(/did not answer/);
    await expect(executor.execute({}, ctx)).rejects.toThrow(/hang/);
  });
});
