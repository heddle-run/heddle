import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** A flow argument that names a download rather than a file on disk. */
export function isRemotePath(path: string): boolean {
  return /^https?:\/\//i.test(path);
}

/** Where a bare entry name resolves: heddle's own library of ready agents. */
export const LIBRARY = 'https://heddle.run/library';

/**
 * A flow argument that reads as a library entry's name rather than a path.
 *
 * The shape is a slug: letters, digits, hyphens, underscores. No dots, so it
 * cannot be a file with an extension, and no separators, so it cannot point
 * anywhere — which is what keeps a mistyped path a path error instead of a
 * surprise request to the library.
 */
export function isLibraryName(flow: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(flow);
}

/** The address of a library entry: one archive per name, beside the index. */
export function libraryUrl(name: string, library: string = LIBRARY): string {
  return `${library}/${name}.heddle`;
}

/** A downloaded archive: where it landed, and how to remove it. */
export interface FetchedBundle {
  path: string;
  dispose(): void;
}

/**
 * The download a flow argument names, fetched — or nothing, for a file here.
 *
 * Two spellings reach the network. An https:// address is taken as typed. A
 * bare name is the library shorthand: `heddle run meeting-notes` runs what
 * `heddle run https://heddle.run/library/meeting-notes.heddle` would, with
 * the part nobody remembers filled in. The disk is consulted first, so a
 * file or directory that answers to the name keeps meaning itself — a
 * shorthand allowed to shadow the working directory would let the library
 * quietly replace a file the caller can see.
 */
export async function fetchRemoteBundle(
  flow: string,
  library: string = LIBRARY,
): Promise<FetchedBundle | undefined> {
  if (isRemotePath(flow)) return downloadBundle(flow);
  if (!isLibraryName(flow) || existsSync(flow)) return undefined;

  const url = libraryUrl(flow, library);
  // Said before the request rather than after: this is the moment a word
  // becomes a network address, and if the fetch hangs, this line names what
  // it is waiting on.
  console.error(`Library: ${url}`);
  return downloadBundle(url, {
    notFound:
      `"${flow}" is not a file here, and the library has no entry by that ` +
      `name — ${url} answered 404. What it does have is at ${library}.`,
  });
}

/**
 * Fetch a `.heddle` archive from a URL into a temporary file.
 *
 * Only bundles travel this way. A bare flow file is refused rather than
 * fetched, because a flow names tools and mounts by path and none of those
 * paths came with it — the archive is the form that carries everything, which
 * is why it is the form worth an address.
 *
 * `messages.notFound` replaces the report for a 404, for a caller who knows
 * what absence means there — a library name has a better story to tell than a
 * status line. Every other status stays the status line, because for those the
 * server's word is the whole of what is known.
 */
export async function downloadBundle(
  url: string,
  messages: { notFound?: string } = {},
): Promise<FetchedBundle> {
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
        response.status === 404 && messages.notFound
          ? messages.notFound
          : `${url} answered ${response.status} ${response.statusText}`,
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
      session: manifest.session,
      maxToolRounds:
        manifest.maxToolRounds === undefined
          ? undefined
          : String(manifest.maxToolRounds),
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
