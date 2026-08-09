import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  BundleError,
  checkedMount,
  extractBundle,
  isBundlePath,
  messageOf,
  parseRequirements,
  type Mount,
  type Requirement,
} from '@heddle-run/core';

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
  /** The bundle recorded that it would rather open a conversation. */
  interactive?: boolean;
  /**
   * What the bundle says this machine must already have. Unlike everything
   * above it is not a flag's worth of defaults — no flag grants a requirement,
   * because none of this is heddle's to grant. It is checked before the run
   * and reported.
   */
  requires: Requirement[];
  /** Remove the extraction directory. */
  dispose(): void;
}

/** A flow argument that names a download rather than a file on disk. */
export function isRemotePath(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/** A downloaded archive: where it landed, and how to remove it. */
export interface FetchedBundle {
  path: string;
  dispose(): void;
}

/**
 * Fetch a `.heddle` archive from a URL into a temporary file.
 *
 * Only bundles travel this way. A bare flow file is refused rather than
 * fetched, because a flow names tools and mounts by path and none of those
 * paths came with it — the archive is the form that carries everything, which
 * is why it is the form worth an address.
 */
export async function downloadBundle(url: string): Promise<FetchedBundle> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new BundleError(`"${url}" is not a usable URL`, { cause: err });
  }
  if (!isBundlePath(parsed.pathname)) {
    throw new BundleError(
      `only .heddle bundles are fetched from a URL. "${url}" names something ` +
        `else — a flow file depends on tools and mounts beside it, and a ` +
        `download has no beside. Bundle it first with "heddle bundle".`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), 'heddle-fetch-'));
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new BundleError(
        `${url} answered ${response.status} ${response.statusText}`,
      );
    }
    const path = join(dir, basename(parsed.pathname));
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    return { path, dispose };
  } catch (err) {
    dispose();
    throw err;
  }
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
      interactive: manifest.interactive,
      requires: manifest.requires ?? [],
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

/**
 * `--requires`, as inline JSON or `@file`.
 *
 * The same two spellings `--plugin-config` takes, for the same reason: a short
 * declaration belongs on the command line and a real one belongs in a file
 * beside the flow. What it is *not* is a flag language of its own — the value
 * is the JSON that lands in the manifest, so what an author reads back in
 * `heddle.json` is what they wrote.
 *
 * One reader for `heddle bundle` and `heddle doctor` both, so a declaration
 * `doctor` accepted is one `bundle` will pack, which is the point of being
 * able to try it before packing it.
 */
export function readRequiresOption(
  raw: string | undefined,
): Requirement[] | undefined {
  if (raw === undefined) return undefined;

  const text = raw.startsWith('@') ? readRequiresFile(raw.slice(1)) : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new BundleError('failed to parse --requires JSON', { cause: err });
  }
  return parseRequirements(parsed);
}

function readRequiresFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    throw new BundleError(
      `--requires @${path}: the file is not readable (${messageOf(err)})`,
    );
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
