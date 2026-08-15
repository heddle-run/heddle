import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadFlow } from '../load.js';
import { loadPlugins } from '../../plugin/loader.js';
import { validateManifest } from '../../plugin/manifest.js';

const examplesDir = join(import.meta.dirname, '../../../../../examples');

/**
 * Whether a JSON file is a plugin manifest rather than a spec.
 *
 * By what is in it, not what it is called. The filename was the rule until an
 * example shipped a manifest that could not be called `manifest.json` — a
 * manifest loaded from disk has to be named after the program beside it, so
 * `policies.json` sits next to `policies.mjs`. A test that reads the name
 * instead of the file was one example away from calling a manifest a broken
 * spec, and it duly did.
 */
function isManifest(filePath: string): boolean {
  if (!filePath.endsWith('.json')) return false;

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return false;

    const candidate = parsed as Record<string, unknown>;
    return (
      typeof candidate.name === 'string' &&
      typeof candidate.version === 'string' &&
      candidate.weave === undefined
    );
  } catch {
    return false;
  }
}

function collectSpecFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSpecFiles(full));
    } else if (
      entry.name.endsWith('.yaml') ||
      entry.name.endsWith('.yml') ||
      entry.name.endsWith('.json')
    ) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Files the extension-based sweep must not judge.
 *
 * The docker-agent example exists to show a spec whose extension does not name
 * its format: a cagent file called `agent.yaml`, read through the
 * `docker-agent` input format its plugin declares. Feeding it to the sweep as
 * YAML would fail for exactly the reason the example gives for `--format`
 * existing. It gets its own test below, loaded the way its README loads it.
 */
const FOREIGN_FORMAT_SPECS = new Set(['docker-agent/agent.yaml']);

const allFiles = collectSpecFiles(examplesDir).sort();
const specFiles = allFiles.filter(
  (f) => !isManifest(f) && !FOREIGN_FORMAT_SPECS.has(relative(examplesDir, f)),
);
const manifestFiles = allFiles.filter(isManifest);

const fileEntries = specFiles.map((f) => [relative(examplesDir, f), f] as const);
const manifestEntries = manifestFiles.map((f) => [relative(examplesDir, f), f] as const);

/**
 * The plugins a spec beside them would be loaded with.
 *
 * Both forms, because an example may ship either: `plugin.js` is the in-process
 * one, and a manifest in the same directory is the out-of-process one. Reading
 * the manifest starts nothing, so this stays as cheap as `heddle validate` — and
 * a spec naming a component type only its own example provides has to be able to
 * find it, or the example's flow is unparseable by the very test that exists to
 * say it parses.
 */
function pluginsBeside(filePath: string): string[] {
  const dir = dirname(filePath);
  const inProcess = join(dir, 'plugin.js');

  return [
    ...(existsSync(inProcess) ? [inProcess] : []),
    ...manifestFiles.filter(
      (manifest) => dirname(manifest) === dir && loadableFromDisk(manifest),
    ),
  ];
}

/**
 * Whether `--plugin <manifest>` would find a program to run.
 *
 * A manifest loaded from disk is matched to the entry point named after it, so
 * `policies.json` runs `policies.mjs`. An example whose manifest has no such
 * neighbour ships programs instead of a process — `examples/skills-agent/` is
 * that shape. Loading it here would fail on an entry point that was never
 * meant to exist.
 */
function loadableFromDisk(manifestPath: string): boolean {
  const base = manifestPath.slice(0, -'.json'.length);
  return ['.mjs', '.js'].some((extension) => existsSync(base + extension));
}

describe('examples', () => {
  it.each(fileEntries)('%s parses and validates', async (_label, filePath) => {
    const plugins = await loadPlugins(pluginsBeside(filePath));

    const flow = loadFlow(filePath, plugins);
    expect(flow.name).toBeTruthy();
    expect(flow.steps.length).toBeGreaterThan(0);
  });

  it('docker-agent/agent.yaml parses through its own input format', async () => {
    const dir = join(examplesDir, 'docker-agent');
    const plugins = await loadPlugins([join(dir, 'format.mjs')]);

    const flow = loadFlow(join(dir, 'agent.yaml'), plugins, {
      format: 'docker-agent',
    });
    expect(flow.name).toBe('quayside');
    expect(flow.steps.map((step) => step.kind)).toContain('agent');
  });

  it.each(manifestEntries)('%s is a valid plugin manifest', (_label, filePath) => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(filePath, 'utf-8')) as unknown,
    );

    expect(manifest.name).toBeTruthy();
    expect(manifest.components.length + manifest.tools.length).toBeGreaterThan(0);
  });
});
