import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { loadComponent } from '../load.js';
import { loadPlugins } from '../../plugin/loader.js';
import { validateManifest } from '../../plugin/manifest.js';

const MANIFEST = 'manifest.json';

const examplesDir = join(import.meta.dirname, '../../../../../examples');

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

const fileEntries = specFiles.map((f) => [relative(examplesDir, f), f] as const);
const manifestEntries = manifestFiles.map((f) => [relative(examplesDir, f), f] as const);

describe('examples', () => {
  it.each(fileEntries)('%s parses and validates', async (_label, filePath) => {
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

  it.each(manifestEntries)('%s is a valid plugin manifest', (_label, filePath) => {
    const manifest = validateManifest(
      JSON.parse(readFileSync(filePath, 'utf-8')) as unknown,
    );

    expect(manifest.name).toBeTruthy();
    expect(manifest.components.length + manifest.tools.length).toBeGreaterThan(0);
  });
});
