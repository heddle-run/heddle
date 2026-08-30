import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { checkedMount } from '../workspace/index.js';
import type { Mount } from '../workspace/index.js';
import { entryFor } from '../plugin/loader.js';
import { readManifest } from '../plugin/remote-loader.js';
import type { Requirement } from '../preflight.js';
import type { BundleManifest } from './format.js';
import { checkPortability, type PortabilityReport } from './portable.js';
import { extractBundle } from './unpack.js';

/**
 * A `.heddle` archive, extracted and resolved into run inputs.
 *
 * Everything a front end needs to run the bundle, in core's own types: parsed
 * objects rather than flag strings, absolute paths inside the extraction
 * directory, mounts already through `checkedMount`. The CLI stringifies these
 * back into flag values; the server hands them to its run pipeline as they
 * are. One translation, so what a bundle means does not depend on who opened
 * it.
 */
export interface OpenedBundle {
  /** The bundle's display name, from its manifest. */
  name: string;
  flowPath: string;
  toolsDir?: string;
  /** Extracted plugin manifest paths, absolute. */
  plugins: string[];
  /** Component settings keyed by component type, as the manifest recorded. */
  pluginConfig: Record<string, Record<string, unknown>>;
  /** Checked mounts rooted in the extraction directory. */
  mounts: Mount[];
  /** The recorded default input, overridable by the caller. */
  input?: Record<string, unknown>;
  /** The bundle recorded that it would rather open a conversation. */
  interactive?: boolean;
  /** The bundle recorded that every run should open a session. */
  session?: boolean;
  /** The recorded default `--max-tool-rounds`, as the manifest wrote it. */
  maxToolRounds?: number | string;
  /**
   * What the bundle says this machine must already have. Unlike everything
   * above it is not a flag's worth of defaults — no flag grants a requirement,
   * because none of this is heddle's to grant. It is checked before the run
   * and reported.
   */
  requires: Requirement[];
  /** The manifest, as validated — for a host that reports on the bundle. */
  manifest: BundleManifest;
  /** The extraction root every path above lives under. */
  dir: string;
  /** Remove the extraction directory. A no-op when the caller owns `dir`. */
  dispose(): void;
}

export interface OpenBundleOptions {
  /** Where the extraction directory is made. Defaults to the OS temp dir. */
  workDir?: string;
  /** How the bundle is named in refusal messages. Defaults to its basename. */
  origin?: string;
}

/**
 * Extract a `.heddle` archive into a fresh temporary directory and resolve it.
 *
 * The directory is the caller's to dispose — through the handle, so a caller
 * that keeps the bundle open across an interactive session holds exactly one
 * thing. A refusal anywhere in extraction or resolution removes the directory
 * before the error travels, so nothing half-opened is left to trust by
 * accident.
 */
export function openBundle(
  archivePath: string,
  options: OpenBundleOptions = {},
): OpenedBundle {
  const dir = mkdtempSync(join(options.workDir ?? tmpdir(), 'heddle-bundle-'));
  const dispose = (): void => rmSync(dir, { recursive: true, force: true });

  try {
    const manifest = extractBundle(archivePath, dir);
    return {
      ...resolveExtractedBundle(manifest, dir, {
        origin: options.origin ?? `bundle "${basename(archivePath)}"`,
      }),
      dispose,
    };
  } catch (err) {
    dispose();
    throw err;
  }
}

/**
 * The resolution half of {@link openBundle}, for a caller that extracted the
 * archive itself — a server re-opening a stored bundle it unpacked at upload
 * time pays for extraction once, not per run. `dispose` is a no-op here: the
 * caller owns `dir` and decides when it goes.
 */
export function resolveExtractedBundle(
  manifest: BundleManifest,
  dir: string,
  options: { origin?: string } = {},
): OpenedBundle {
  const origin = options.origin ?? `bundle "${manifest.name}"`;

  return {
    name: manifest.name,
    flowPath: join(dir, ...manifest.flow.split('/')),
    toolsDir:
      manifest.tools === undefined
        ? undefined
        : join(dir, ...manifest.tools.split('/')),
    plugins: manifest.plugins.map((path) => join(dir, ...path.split('/'))),
    pluginConfig: manifest.pluginConfig,
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
    input: manifest.input,
    interactive: manifest.interactive,
    session: manifest.session,
    maxToolRounds: manifest.maxToolRounds,
    requires: manifest.requires ?? [],
    manifest,
    dir,
    dispose: () => {},
  };
}

/**
 * Whether this opened bundle could run on a host that starts no processes.
 *
 * The Node half of `checkPortability`: reads each plugin's manifest, resolves
 * its entry the way the loader would, and hands the pure check what it needs.
 * A host that extracted the bundle natively applies the same rules to the same
 * files itself.
 */
export function bundlePortability(bundle: OpenedBundle): PortabilityReport {
  const plugins = bundle.plugins.map((path) => {
    const manifest = readManifest(path);
    const entry = entryFor(path, manifest);
    const isScript =
      entry !== undefined &&
      (entry.endsWith('.mjs') || entry.endsWith('.js'));

    return {
      manifest,
      entry,
      entrySource: isScript ? readFileSync(entry, 'utf-8') : undefined,
    };
  });

  return checkPortability(bundle.manifest, plugins);
}
