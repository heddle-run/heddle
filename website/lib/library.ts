import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  parseRequirements,
  requirementLabel,
  type Requirement,
} from "../../packages/core/src/preflight";

/**
 * The bundle library, read off disk at build time.
 *
 * `library/` at the repository root is the source of truth: each entry's
 * `bundle.json` is both the recipe `library/build.mjs` packs it with and the
 * copy this site lists it under. Nothing is duplicated into the website, and
 * nothing is generated into the repository — adding a bundle is adding a
 * directory, and the next build lists it.
 *
 * The export is static (`output: "export"`), so every one of these reads
 * happens during `next build` and none of it ships to a browser.
 */

const LIBRARY_DIR = resolve(process.cwd(), "..", "library");

/** Directories that are packing output or noise, never part of an entry. */
const SKIP = new Set(["dist", "node_modules", "__pycache__"]);

/**
 * What an entry needs from the machine, read by heddle's own parser.
 *
 * Imported from `packages/core` rather than reimplemented here, because this
 * page and `heddle run` are making the same claim about the same file: what a
 * reader is told to install is exactly what the run will check for. Two readers
 * of one field drift, and the drift is silent — a listing that says a bundle
 * needs nothing while the bundle refuses to start.
 *
 * It also means this page understands the older `{ env, binaries }` object for
 * as long as heddle does, and stops the day heddle does.
 */
export type { Requirement };

export interface LibraryEntry {
  /** Directory name, and the entry's address under /library. */
  name: string;
  title: string;
  /** One line, for the card. */
  summary: string;
  /** A paragraph, for the entry's own page. */
  blurb: string;
  tags: string[];
  model?: string;
  flow: string;
  toolsDir?: string;
  plugins: string[];
  mounts: string[];
  input: Record<string, unknown>;
  requires: Requirement[];
  /** The bundle opens the chat UI when run at a terminal. */
  interactive: boolean;
  /** The bundle keeps every run in a session on disk. */
  session: boolean;
  /** A recorded default --max-tool-rounds, if the bundle set one. */
  maxToolRounds?: number | string;
  /** Every file the entry ships, relative to its directory. */
  files: string[];
  /** Tool executables, by the name a spec refers to them by. */
  tools: string[];
  /** The spec, as text. Rendered, not parsed — the file is the authority. */
  spec: string;
}

function walk(dir: string, root: string, out: string[]): void {
  for (const item of readdirSync(dir).sort()) {
    if (item.startsWith(".") || SKIP.has(item)) continue;
    const path = join(dir, item);
    if (statSync(path).isDirectory()) walk(path, root, out);
    else out.push(relative(root, path));
  }
}

function read(name: string): LibraryEntry | null {
  const dir = join(LIBRARY_DIR, name);
  const manifestPath = join(dir, "bundle.json");
  if (!existsSync(manifestPath)) return null;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

  const files: string[] = [];
  walk(dir, dir, files);

  // A tool's name is its filename with the extension stripped — the same rule
  // heddle matches a ServerTool to an executable by.
  const toolsDir = manifest.toolsDir;
  const tools = toolsDir
    ? files
        .filter((file) => file.startsWith(`${toolsDir}/`))
        .map((file) => file.slice(toolsDir.length + 1).replace(/\.[^.]+$/, ""))
        .sort()
    : [];

  const specPath = join(dir, manifest.flow);

  return {
    name,
    title: manifest.title,
    summary: manifest.summary,
    blurb: manifest.blurb,
    tags: manifest.tags ?? [],
    model: manifest.model,
    flow: manifest.flow,
    toolsDir,
    plugins: manifest.plugins ?? [],
    mounts: manifest.mounts ?? [],
    input: manifest.input ?? {},
    requires: parseRequirements(manifest.requires),
    interactive: manifest.interactive === true,
    session: manifest.session === true,
    maxToolRounds: manifest.maxToolRounds,
    files,
    tools,
    spec: existsSync(specPath) ? readFileSync(specPath, "utf8") : "",
  };
}

/** How much a reader has to have in place before an entry runs. */
function setupWeight(entry: LibraryEntry): number {
  return entry.requires.length;
}

/** What an entry needs, in the words heddle itself would use for it. */
export function requirementNames(entry: LibraryEntry): string[] {
  return entry.requires.map(requirementLabel);
}

export function libraryEntries(): LibraryEntry[] {
  // A missing directory is not a broken build. The site is deployed from a
  // checkout that has it, but a fork, a preview or a bare website/ copy should
  // render an empty library rather than fail.
  if (!existsSync(LIBRARY_DIR)) return [];

  const entries = readdirSync(LIBRARY_DIR)
    .filter((name) => !SKIP.has(name))
    .filter((name) => statSync(join(LIBRARY_DIR, name)).isDirectory())
    .map(read)
    .filter((entry): entry is LibraryEntry => entry !== null);

  // Cheapest to try first, then alphabetical. Ordering the index by what a
  // reader has to install beats ordering it by name: the first card is the one
  // they can run now.
  return entries.sort(
    (a, b) => setupWeight(a) - setupWeight(b) || a.title.localeCompare(b.title),
  );
}

export function libraryEntry(name: string): LibraryEntry | undefined {
  return libraryEntries().find((entry) => entry.name === name);
}
