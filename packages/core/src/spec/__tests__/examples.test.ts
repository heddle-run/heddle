import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadComponent } from '../load.js';
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
      candidate.component_type === undefined
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

const allFiles = collectSpecFiles(examplesDir).sort();
const specFiles = allFiles.filter((f) => !isManifest(f));
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
 * neighbour is one that is only ever *submitted* to a server, where the source
 * travels in the request body — `examples/ag-ui/` is that shape. Loading it here
 * would fail on a program that was never meant to be on disk.
 */
function loadableFromDisk(manifestPath: string): boolean {
  const base = manifestPath.slice(0, -'.json'.length);
  return ['.mjs', '.js'].some((extension) => existsSync(base + extension));
}

describe('examples', () => {
  it.each(fileEntries)('%s parses and validates', async (_label, filePath) => {
    const plugins = await loadPlugins(pluginsBeside(filePath));

    const component = loadComponent(filePath, plugins);
    const ct = (component as unknown as { componentType: string }).componentType;
    const name = (component as unknown as { name: string }).name;
    expect(ct).toBeTruthy();
    expect(name).toBeTruthy();
  });

  it.each(manifestEntries)('%s is a valid plugin manifest', (_label, filePath) => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(filePath, 'utf-8')) as unknown,
    );

    expect(manifest.name).toBeTruthy();
    expect(manifest.components.length + manifest.tools.length).toBeGreaterThan(0);
  });
});
