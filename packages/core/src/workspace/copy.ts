import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { WorkspaceError } from '../errors.js';

export interface CopyBudget {
  maxBytes: number;
  maxEntries: number;
}

/** What a file looked like when it was copied in. */
export interface FileStamp {
  size: number;
  mtimeMs: number;
}

/**
 * Copy a file or a directory into the workspace.
 *
 * `fs.cpSync` would do this in one line and is not used: it was experimental
 * until Node 22.3 and this package supports 18, where it prints a warning to
 * stderr on every run. The walk is wanted anyway — refusing symlinks and
 * counting against the budget are the same traversal, and doing them here means
 * a mount that is too big fails before anything has been copied twice.
 */
export function copyTree(
  source: string,
  dest: string,
  what: string,
  budget?: CopyBudget,
): FileStamp {
  const info = lstatSync(source);

  if (info.isSymbolicLink()) {
    throw new WorkspaceError(
      `${what}: "${source}" is a symbolic link. A link in a workspace resolves ` +
        `outside it, which puts whatever it points at beyond every guarantee ` +
        `the workspace makes — so it is refused rather than followed. Name what ` +
        `it points at instead.`,
    );
  }

  if (info.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    const spent = { bytes: 0, entries: 0 };
    copyInto(source, dest, what, budget, spent);
    return { size: spent.bytes, mtimeMs: info.mtimeMs };
  }

  if (!info.isFile()) {
    throw new WorkspaceError(
      `${what}: "${source}" is neither a file nor a directory. A workspace ` +
        `holds files; a socket or a device is not something heddle can copy.`,
    );
  }

  charge(what, budget, { bytes: info.size, entries: 1 });
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(source, dest);
  return { size: info.size, mtimeMs: info.mtimeMs };
}

function copyInto(
  source: string,
  dest: string,
  what: string,
  budget: CopyBudget | undefined,
  spent: { bytes: number; entries: number },
): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(dest, entry.name);

    if (entry.isSymbolicLink()) {
      throw new WorkspaceError(
        `${what}: "${from}" is a symbolic link. A link in a workspace resolves ` +
          `outside it, which puts whatever it points at beyond every guarantee ` +
          `the workspace makes — so it is refused rather than followed.`,
      );
    }

    if (entry.isDirectory()) {
      spent.entries += 1;
      charge(what, budget, spent);
      mkdirSync(to, { recursive: true });
      copyInto(from, to, what, budget, spent);
      continue;
    }

    if (!entry.isFile()) continue;

    const info = statSync(from);
    spent.bytes += info.size;
    spent.entries += 1;
    charge(what, budget, spent);

    copyFileSync(from, to);
    // Carried across so a copy-back can tell what the run changed from what it
    // merely read. Without it every file looks new the moment it is copied in.
    utimesSync(to, info.atime, info.mtime);
  }
}

function charge(
  what: string,
  budget: CopyBudget | undefined,
  spent: { bytes: number; entries: number },
): void {
  if (!budget) return;

  if (spent.entries > budget.maxEntries) {
    throw new WorkspaceError(
      `${what}: more than ${budget.maxEntries} files and directories. This is ` +
        `copied once per node, so a large tree is paid for on every node the ` +
        `flow runs. Mount a subdirectory, or raise --mount-max-entries.`,
    );
  }
  if (spent.bytes > budget.maxBytes) {
    throw new WorkspaceError(
      `${what}: over ${budget.maxBytes} bytes. This is copied once per node, ` +
        `so a large tree is paid for on every node the flow runs. Mount a ` +
        `subdirectory, or raise --mount-max-bytes.`,
    );
  }
}

/**
 * What every file under `path` looked like, by path relative to it.
 *
 * Size and mtime, not a hash. A copy-back only has to answer "did the run touch
 * this", and hashing a mount at both ends of every node scope would cost more
 * than the copy it is deciding about.
 *
 * A mount that is a single file gets a one-entry map under the empty key, so
 * the file and directory cases stay one code path: `join(dir, '')` is `dir`,
 * which is exactly the identity a single file needs.
 */
export function stampTree(path: string): Map<string, FileStamp> {
  const stamps = new Map<string, FileStamp>();

  const info = statSync(path);
  if (info.isFile()) {
    stamps.set('', { size: info.size, mtimeMs: info.mtimeMs });
    return stamps;
  }

  walk(path, path, stamps);
  return stamps;
}

function walk(
  root: string,
  dir: string,
  stamps: Map<string, FileStamp>,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, path, stamps);
      continue;
    }
    if (!entry.isFile()) continue;

    const info = statSync(path);
    stamps.set(relative(root, path), {
      size: info.size,
      mtimeMs: info.mtimeMs,
    });
  }
}

export interface CopyBackResult {
  written: string[];
  /** Host files that moved under the run's feet and were overwritten anyway. */
  overwritten: string[];
}

/**
 * What a mount looked like on both sides when this scope copied it in.
 *
 * Two baselines, not one, because the two questions are about different files.
 * "Did the run change this?" compares the workspace copy against itself. "Did
 * somebody else change it?" compares the *host* file against itself. Answering
 * the second against the workspace baseline reports every file as contested:
 * copying preserves mtime only to the millisecond a `Date` carries, and the
 * sub-millisecond remainder is enough to look like a change.
 */
export interface MountBaseline {
  taken: Map<string, FileStamp>;
  host: Map<string, FileStamp>;
}

/**
 * Put back what the run changed.
 *
 * Only files, and only the ones that are new or whose size or mtime moved.
 * **Deletions do not propagate**: a copy-back that deleted would turn the
 * model's `rm -rf` in a scratch directory into deletion of the operator's
 * files, and the operator's directory is the one thing here that is not
 * disposable. A model that wants a file gone writes an empty one and says so.
 *
 * A host file that changed during the run is overwritten and named in
 * `overwritten`, rather than skipped. Last writer wins is predictable; a rule
 * that silently declines to write back some of what the run produced is the
 * kind of thing nobody discovers until they needed the file.
 */
export function copyBack(
  from: string,
  to: string,
  baseline: MountBaseline,
): CopyBackResult {
  const now = stampTree(from);
  const written: string[] = [];
  const overwritten: string[] = [];

  for (const [path, stamp] of now) {
    const before = baseline.taken.get(path);
    if (before && before.size === stamp.size && before.mtimeMs === stamp.mtimeMs) {
      continue;
    }

    const target = join(to, path);
    const hostBefore = baseline.host.get(path);
    if (hostBefore !== undefined && movedOnHost(target, hostBefore)) {
      overwritten.push(path === '' ? basename(target) : path);
    }

    mkdirSync(join(target, '..'), { recursive: true });
    copyFileSync(join(from, path), target);
    written.push(path === '' ? basename(target) : path);
  }

  return { written, overwritten };
}

function movedOnHost(target: string, before: FileStamp): boolean {
  try {
    const info = statSync(target);
    return info.size !== before.size || info.mtimeMs !== before.mtimeMs;
  } catch {
    return false;
  }
}
