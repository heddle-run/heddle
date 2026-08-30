import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BundleError } from '../errors.js';
import { isBundlePath } from './format.js';
import { isLibraryName, isRemotePath, libraryUrl, LIBRARY } from './library.js';

/** A downloaded archive: where it landed, and how to remove it. */
export interface FetchedBundle {
  path: string;
  dispose(): void;
}

export interface FetchRemoteBundleOptions {
  /** Where a bare name resolves. Defaults to heddle's own library. */
  library?: string;
  /**
   * Told the moment a word becomes a network address, before the request is
   * made — if the fetch hangs, this line names what it is waiting on. The CLI
   * passes stderr; a host with no terminal passes nothing and stays quiet.
   */
  log?: (message: string) => void;
}

/**
 * The download a flow argument names, fetched — or nothing, for a file here.
 *
 * Two spellings reach the network. An https:// address is taken as typed. A
 * bare name is the library shorthand: `heddle run coding-agent` runs what
 * `heddle run https://heddle.run/library/coding-agent.heddle` would, with
 * the part nobody remembers filled in. The disk is consulted first, so a
 * file or directory that answers to the name keeps meaning itself — a
 * shorthand allowed to shadow the working directory would let the library
 * quietly replace a file the caller can see.
 */
export async function fetchRemoteBundle(
  flow: string,
  options: FetchRemoteBundleOptions = {},
): Promise<FetchedBundle | undefined> {
  const library = options.library ?? LIBRARY;

  if (isRemotePath(flow)) return downloadBundle(flow);
  if (!isLibraryName(flow) || existsSync(flow)) return undefined;

  const url = libraryUrl(flow, library);
  options.log?.(`Library: ${url}`);
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
