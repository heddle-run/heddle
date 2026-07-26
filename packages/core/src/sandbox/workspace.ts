/** Shared workspace lifecycle, used identically by both backends. */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Keeps workspace directory names readable and safe to embed in a path. */
function slug(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 40) || 'session';
}

/**
 * Creates the host directory backing one session. The label is the owning
 * node's name, so `ls $TMPDIR` during a run shows which agent owns what.
 */
export function createWorkspace(label: string): string {
  return mkdtempSync(join(tmpdir(), `heddle-ws-${slug(label)}-`));
}

/** Removes a directory, ignoring failures. */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A leftover directory under TMPDIR is not worth failing a run over.
  }
}
