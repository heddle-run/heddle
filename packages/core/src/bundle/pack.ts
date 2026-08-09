import {
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { BundleError } from '../errors.js';
import { validateManifest } from '../plugin/manifest.js';
import type { Requirement } from '../preflight.js';
import type { Mount } from '../workspace/types.js';
import {
  BUNDLE_FORMAT,
  BUNDLE_MANIFEST,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_ENTRIES,
  type BundleManifest,
  type BundleMount,
} from './format.js';
import { writeTarGz, type TarEntry } from './tar.js';

/** Everything `heddle bundle` decided, before any file is read. */
export interface BundlePlan {
  /** The flow's name, carried for display. */
  name: string;
  flowPath: string;
  toolsDir?: string;
  /** Paths of plugin manifests (`.json`) — each ships its whole directory. */
  pluginManifests: string[];
  pluginConfig: Record<string, Record<string, unknown>>;
  /** Already through `parseMount`, so sources exist and dests are lawful. */
  mounts: Mount[];
  input?: Record<string, unknown>;
  /** Already through `parseRequirements`, so every predicate is readable. */
  requires?: Requirement[];
  /** Record that this bundle would rather open a conversation than run once. */
  interactive?: boolean;
}

export interface PackedBundle {
  path: string;
  /** Compressed size on disk. */
  bytes: number;
  entries: number;
  /** Plugin names, in the order they were packed. */
  plugins: string[];
}

const EXECUTABLE_BITS = 0o111;

/**
 * Write a plan out as a `.heddle` archive.
 *
 * A plugin is packed as its entire directory, not the files its manifest
 * names. The manifest's own confinement rule — everything a plugin references
 * resolves inside its directory — makes the directory the unit of meaning, and
 * an entry point is free to import a sibling the manifest never mentions.
 */
export function packBundle(plan: BundlePlan, outPath: string): PackedBundle {
  const entries: TarEntry[] = [];
  const spent = { bytes: 0, entries: 0 };

  const flow = `flow/${basename(plan.flowPath)}`;
  addFile(entries, spent, flow, plan.flowPath, `flow "${plan.flowPath}"`);

  const tools = plan.toolsDir === undefined ? undefined : 'tools';
  if (plan.toolsDir !== undefined) {
    addTools(entries, spent, plan.toolsDir);
  }

  const plugins = plan.pluginManifests.map((manifestPath) =>
    addPlugin(entries, spent, manifestPath),
  );

  const mounts = plan.mounts.map((mount, i) =>
    addMount(entries, spent, mount, i),
  );

  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    name: plan.name,
    flow,
    tools,
    plugins: plugins.map((plugin) => plugin.manifest),
    pluginConfig: plan.pluginConfig,
    mounts,
    input: plan.input,
    // Only when there are any, so a bundle that needs nothing carries no key
    // rather than an empty list somebody has to interpret.
    requires: plan.requires?.length ? plan.requires : undefined,
    interactive: plan.interactive ? true : undefined,
  };

  entries.unshift({
    name: BUNDLE_MANIFEST,
    data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
  });

  const archive = writeTarGz(entries);
  writeFileSync(outPath, archive);

  return {
    path: outPath,
    bytes: archive.length,
    entries: entries.length,
    plugins: plugins.map((plugin) => plugin.name),
  };
}

/**
 * The tools directory, flat, the way `FileRegistry` will read it back.
 *
 * Subdirectories are skipped rather than refused because the registry skips
 * them too — a `lib/` beside the tools is not an error today and does not
 * become one by being bundled. What must survive is the executable bit: it is
 * the whole of what makes a file in this directory a tool.
 */
function addTools(
  entries: TarEntry[],
  spent: Spent,
  toolsDir: string,
): void {
  assertDirectory(toolsDir, `--tools-dir "${toolsDir}"`);
  entries.push({ name: 'tools' });

  for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(toolsDir, entry.name);
    refuseSymlink(path, `--tools-dir "${toolsDir}"`);
    if (!lstatSync(path).isFile()) continue;

    addFile(entries, spent, `tools/${entry.name}`, path, `--tools-dir "${toolsDir}"`);
  }
}

function addPlugin(
  entries: TarEntry[],
  spent: Spent,
  manifestPath: string,
): { name: string; manifest: string } {
  const raw = readManifestJson(manifestPath);
  const name = validateManifest(raw).name;

  const root = `plugins/${name}`;
  if (entries.some((entry) => entry.name === root)) {
    throw new BundleError(
      `two plugins are both named "${name}", so their directories would land ` +
        `on the same place in the bundle.`,
    );
  }

  addTree(entries, spent, dirname(manifestPath), root, `plugin "${name}"`);
  return { name, manifest: `${root}/${basename(manifestPath)}` };
}

function readManifestJson(manifestPath: string): unknown {
  let text: string;
  try {
    text = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    throw new BundleError(`cannot read plugin manifest "${manifestPath}"`, {
      cause: err,
    });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BundleError(`plugin manifest "${manifestPath}" is not JSON`, {
      cause: err,
    });
  }
}

function addMount(
  entries: TarEntry[],
  spent: Spent,
  mount: Mount,
  index: number,
): BundleMount {
  const root = `mounts/${index}`;
  const what = `--mount "${mount.source}"`;

  if (statSync(mount.source).isDirectory()) {
    addTree(entries, spent, mount.source, root, what);
  } else {
    addFile(entries, spent, root, mount.source, what);
  }

  return { path: root, dest: mount.dest, mode: mount.mode };
}

interface Spent {
  bytes: number;
  entries: number;
}

function addTree(
  entries: TarEntry[],
  spent: Spent,
  dir: string,
  root: string,
  what: string,
): void {
  assertDirectory(dir, what);
  entries.push({ name: root });

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const name = `${root}/${entry.name}`;

    if (entry.isSymbolicLink()) {
      // The same refusal the workspace copy makes, for the same reason — and
      // one more: a link written into an archive is a write through it on
      // whatever machine extracts it.
      throw new BundleError(
        `${what}: "${path}" is a symbolic link. A bundle carries files, and a ` +
          `link resolves on the machine that extracts it — outside the bundle. ` +
          `Name what it points at instead.`,
      );
    }
    if (entry.isDirectory()) {
      charge(what, spent, 0);
      addTree(entries, spent, path, name, what);
      continue;
    }
    if (!entry.isFile()) continue;

    addFile(entries, spent, name, path, what);
  }
}

function addFile(
  entries: TarEntry[],
  spent: Spent,
  name: string,
  path: string,
  what: string,
): void {
  refuseSymlink(path, what);
  const info = statSync(path);
  charge(what, spent, info.size);

  entries.push({
    name,
    data: readFileSync(path),
    executable: (info.mode & EXECUTABLE_BITS) !== 0,
  });
}

function charge(what: string, spent: Spent, bytes: number): void {
  spent.bytes += bytes;
  spent.entries += 1;

  if (spent.entries > MAX_BUNDLE_ENTRIES) {
    throw new BundleError(
      `${what} takes the bundle over ${MAX_BUNDLE_ENTRIES} entries. A plugin ` +
        `is bundled as its whole directory, so a node_modules or a build tree ` +
        `beside its manifest is bundled too — give the plugin a directory that ` +
        `holds only what it ships.`,
    );
  }
  if (spent.bytes > MAX_BUNDLE_BYTES) {
    throw new BundleError(
      `${what} takes the bundle over ${MAX_BUNDLE_BYTES} bytes. A bundle is ` +
        `unpacked whole by whoever runs it, so its size is a cost every ` +
        `recipient pays.`,
    );
  }
}

function refuseSymlink(path: string, what: string): void {
  if (!lstatSync(path).isSymbolicLink()) return;
  throw new BundleError(
    `${what}: "${path}" is a symbolic link. A bundle carries files, and a ` +
      `link resolves on the machine that extracts it — outside the bundle. ` +
      `Name what it points at instead.`,
  );
}

function assertDirectory(dir: string, what: string): void {
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch (err) {
    throw new BundleError(`${what}: "${dir}" is not accessible`, { cause: err });
  }
  if (!isDir) {
    throw new BundleError(`${what}: "${dir}" is not a directory`);
  }
}
