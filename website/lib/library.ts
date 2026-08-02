import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

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

export interface LibraryRequires {
  env?: string[];
  binaries?: string[];
}

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
  requires: LibraryRequires;
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
    requires: manifest.requires ?? {},
    files,
    tools,
    spec: existsSync(specPath) ? readFileSync(specPath, "utf8") : "",
  };
}

/** How much a reader has to have in place before an entry runs. */
function setupWeight(entry: LibraryEntry): number {
  return (
    (entry.requires.env?.length ?? 0) + (entry.requires.binaries?.length ?? 0)
  );
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

/**
 * The command that packs an entry — the same one `library/build.mjs` runs,
 * written out so the page shows what the script does rather than only its name.
 */
export function bundleCommand(entry: LibraryEntry): string {
  const parts = [`heddle bundle library/${entry.name}/${entry.flow}`];

  if (entry.toolsDir) {
    parts.push(`--tools-dir library/${entry.name}/${entry.toolsDir}`);
  }
  for (const plugin of entry.plugins) {
    parts.push(`--plugin library/${entry.name}/${plugin}`);
  }
  for (const mount of entry.mounts) {
    const [source, ...rest] = mount.split(":");
    parts.push(
      `--mount ${[`library/${entry.name}/${source}`, ...rest].join(":")}`,
    );
  }
  parts.push(`--input '${JSON.stringify(entry.input)}'`);
  parts.push(`-o ${entry.name}.heddle`);

  return parts.join(" \\\n  ");
}
