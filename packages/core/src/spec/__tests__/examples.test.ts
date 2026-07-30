import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { loadComponent } from '../load.js';
import { loadPlugins } from '../../plugin/loader.js';
import { validateManifest } from '../../plugin/manifest.js';

/**
 * A plugin manifest is JSON under `examples/` that is not a spec.
 *
 * The walk below assumed every YAML/JSON file here was an Agent Spec component,
 * which held until an example shipped an out-of-process plugin — a manifest
 * describes what a plugin *provides* and would fail `loadComponent` for the
 * honest reason that it is not a component. Named here rather than skipped
 * silently, and checked by {@link validateManifest} in its own case below, so
 * "every file in examples is validated" stays true rather than becoming "every
 * file except the ones that were awkward".
 */
const MANIFEST = 'manifest.json';

// The example specs live at the repository root, not inside this package:
// packages/core/src/spec/__tests__ -> spec -> src -> core -> packages -> root.
const examplesDir = join(import.meta.dirname, '../../../../../examples');

/** Recursively collect all YAML/JSON spec files from the examples directory. */
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
const specFiles = allFiles.filter((f) => basename(f) !== MANIFEST);
const manifestFiles = allFiles.filter((f) => basename(f) === MANIFEST);

/** Map from relative path to absolute path for test display. */
const fileEntries = specFiles.map((f) => [relative(examplesDir, f), f] as const);
const manifestEntries = manifestFiles.map((f) => [relative(examplesDir, f), f] as const);

describe('examples', () => {
  it.each(fileEntries)('%s parses and validates', async (_label, filePath) => {
    // An example that ships a plugin.js defines custom component types, and
    // cannot be deserialized without loading it first.
    const pluginPath = join(dirname(filePath), 'plugin.js');
    const plugins = await loadPlugins(
      existsSync(pluginPath) ? [pluginPath] : undefined,
    );

    const component = loadComponent(filePath, plugins);
    const ct = (component as unknown as { componentType: string }).componentType;
    const name = (component as unknown as { name: string }).name;
    expect(ct).toBeTruthy();
    expect(name).toBeTruthy();
  });

  // An out-of-process example's manifest is the half heddle reads as data, and
  // the half a reader of the example copies. A manifest that would be refused at
  // load is a README that teaches a shape nothing accepts.
  it.each(manifestEntries)('%s is a valid plugin manifest', (_label, filePath) => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(filePath, 'utf-8')) as unknown,
    );

    expect(manifest.name).toBeTruthy();
    expect(manifest.components.length + manifest.tools.length).toBeGreaterThan(0);
  });
});
