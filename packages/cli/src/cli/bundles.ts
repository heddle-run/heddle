import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkedMount, extractBundle, type Mount } from '@heddle-run/core';

/**
 * A `.heddle` archive, extracted and translated back into run inputs.
 *
 * Everything here is exactly what the corresponding flag would have carried,
 * so `run` and `validate` treat an opened bundle as a set of defaults rather
 * than a second code path: the merge below writes them into the same options
 * object the flags parse into, and everything downstream is unchanged.
 */
export interface OpenedBundle {
  /** The bundle's display name, from its manifest. */
  name: string;
  flowPath: string;
  toolsDir?: string;
  /** Extracted plugin manifest paths, ready for `--plugin`. */
  plugins: string[];
  /** `<ComponentType>=<json>` entries, ready for `--plugin-config`. */
  pluginConfig: string[];
  /** Checked mounts rooted in the extraction directory. */
  mounts: Mount[];
  /** The recorded default input, as `--input` JSON. */
  input?: string;
  /** Remove the extraction directory. */
  dispose(): void;
}

export function openBundle(archivePath: string): OpenedBundle {
  const dir = mkdtempSync(join(tmpdir(), 'heddle-bundle-'));
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });

  try {
    const manifest = extractBundle(archivePath, dir);
    const origin = `bundle "${basename(archivePath)}"`;

    return {
      name: manifest.name,
      flowPath: join(dir, manifest.flow),
      toolsDir:
        manifest.tools === undefined ? undefined : join(dir, manifest.tools),
      plugins: manifest.plugins.map((path) => join(dir, path)),
      pluginConfig: Object.entries(manifest.pluginConfig).map(
        ([componentType, settings]) =>
          `${componentType}=${JSON.stringify(settings)}`,
      ),
      // Through `checkedMount` like a `--mount` would be, so a bundle's word
      // about where things land is held to the operator's rules — a dest that
      // climbs or claims `.heddle` is refused here, not discovered mid-run.
      mounts: manifest.mounts.map((mount) =>
        checkedMount({
          source: join(dir, ...mount.path.split('/')),
          dest: mount.dest,
          mode: mount.mode,
          origin,
        }),
      ),
      input:
        manifest.input === undefined
          ? undefined
          : JSON.stringify(manifest.input),
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

interface BundleAwareOptions {
  toolsDir?: string;
  plugin?: string[];
  pluginConfig?: string[];
  input?: string;
}

/**
 * Write a bundle's contents into the options a run parses its flags into.
 *
 * The rule throughout: the bundle proposes, the command line disposes. A flag
 * the caller typed wins over what the bundle recorded — singular values are
 * kept, and list values compose with the bundle's first, so a collision
 * message names the bundle before it names the caller.
 */
export function mergeBundleOptions(
  options: BundleAwareOptions,
  bundle: OpenedBundle,
): void {
  options.toolsDir ??= bundle.toolsDir;
  options.input ??= bundle.input;
  options.plugin = [...bundle.plugins, ...(options.plugin ?? [])];

  const overridden = new Set(
    (options.pluginConfig ?? []).map((entry) => configType(entry)),
  );
  options.pluginConfig = [
    ...bundle.pluginConfig.filter((entry) => !overridden.has(configType(entry))),
    ...(options.pluginConfig ?? []),
  ];
}

function configType(entry: string): string {
  const separator = entry.indexOf('=');
  return separator > 0 ? entry.slice(0, separator) : entry;
}
