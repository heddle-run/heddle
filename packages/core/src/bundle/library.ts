/**
 * How a flow argument names a bundle that lives somewhere else.
 *
 * Pure string reasoning, shared by every front end: the CLI resolves a bare
 * name before fetching, and an app offering the library resolves the same name
 * to the same address. Nothing here touches the network — the fetch half lives
 * in `fetch.ts`, which only Node hosts import.
 */

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
