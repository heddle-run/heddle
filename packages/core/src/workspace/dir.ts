import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MAX_SLUG_LENGTH = 40;
const UNSAFE_PATH_CHARS = /[^A-Za-z0-9._-]+/g;
const LEADING_OR_TRAILING_DASHES = /^-+|-+$/g;

export function createWorkspace(label: string): string {
  return mkdtempSync(join(tmpdir(), `heddle-ws-${slug(label)}-`));
}

export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    return;
  }
}

export function slug(label: string): string {
  const cleaned = label
    .replace(UNSAFE_PATH_CHARS, '-')
    .replace(LEADING_OR_TRAILING_DASHES, '');
  return cleaned.slice(0, MAX_SLUG_LENGTH) || 'session';
}
