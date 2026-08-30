import { readFileSync } from 'node:fs';
import {
  BundleError,
  LIBRARY,
  messageOf,
  openBundle as openBundleCore,
  parseRequirements,
  fetchRemoteBundle as fetchRemoteBundleCore,
  type FetchedBundle,
  type Mount,
  type Requirement,
} from '@heddle-run/core';

/**
 * A `.heddle` archive, extracted and translated back into run inputs.
 *
 * Core's `openBundle` does the opening; this shape is the CLI's rendering of
 * it — everything here is exactly what the corresponding flag would have
 * carried, so `run` and `validate` treat an opened bundle as a set of defaults
 * rather than a second code path: the merge below writes them into the same
 * options object the flags parse into, and everything downstream is unchanged.
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
  /** The bundle recorded that every run should open a session. */
  session?: boolean;
  /** The recorded default `--max-tool-rounds`, as a flag string. */
  maxToolRounds?: string;
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

export {
  downloadBundle,
  isLibraryName,
  isRemotePath,
  LIBRARY,
  libraryUrl,
} from '@heddle-run/core';
export type { FetchedBundle } from '@heddle-run/core';

/**
 * The download a flow argument names, fetched — or nothing, for a file here.
 *
 * Core does the resolving and the fetching; the CLI's part is the stderr line
 * naming the address before the request is made, so a hung fetch says what it
 * is waiting on.
 */
export async function fetchRemoteBundle(
  flow: string,
  library: string = LIBRARY,
): Promise<FetchedBundle | undefined> {
  return fetchRemoteBundleCore(flow, {
    library,
    log: (message) => console.error(message),
  });
}

export function openBundle(archivePath: string): OpenedBundle {
  const bundle = openBundleCore(archivePath);

  return {
    name: bundle.name,
    flowPath: bundle.flowPath,
    toolsDir: bundle.toolsDir,
    plugins: bundle.plugins,
    pluginConfig: Object.entries(bundle.pluginConfig).map(
      ([componentType, settings]) =>
        `${componentType}=${JSON.stringify(settings)}`,
    ),
    mounts: bundle.mounts,
    input: bundle.input === undefined ? undefined : JSON.stringify(bundle.input),
    interactive: bundle.interactive,
    session: bundle.session,
    maxToolRounds:
      bundle.maxToolRounds === undefined
        ? undefined
        : String(bundle.maxToolRounds),
    requires: bundle.requires,
    dispose: bundle.dispose,
  };
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
  session?: string | boolean;
  maxToolRounds?: string;
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
  options.maxToolRounds ??= bundle.maxToolRounds;
  // A bundle asking for a session proposes a fresh one (`true`). The caller's
  // `--session <id>`, bare `--session`, or `--no-session` all land first and
  // win, since each leaves `options.session` defined before this runs.
  if (bundle.session && options.session === undefined) options.session = true;
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
