import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { loadComponent } from '../load.js';
import { loadPlugins } from '../../plugin/loader.js';

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

const specFiles = collectSpecFiles(examplesDir).sort();

/** Map from relative path to absolute path for test display. */
const fileEntries = specFiles.map((f) => [relative(examplesDir, f), f] as const);

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
});
