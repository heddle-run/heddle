import { WorkspaceError } from '../errors.js';
import type { Mount } from './types.js';

/**
 * Refuse two mounts that would land on top of each other.
 *
 * By prefix rather than by string equality, so `skills` and `skills/extra`
 * collide: the second would be written inside the first, and which one a tool
 * then reads depends on the order they were copied. Naming both origins matters
 * because one of them is often a plugin the operator did not write.
 *
 * In its own module, apart from the mount checks that stat and realpath: this
 * one judges declared destinations, which is pure string work — and the plugin
 * registry, which runs on hosts with no filesystem, is one of its callers.
 */
export function assertNoCollisions(mounts: Mount[]): void {
  const claimed: Mount[] = [];

  for (const mount of mounts) {
    const clash = claimed.find((other) => overlaps(other.dest, mount.dest));
    if (clash) {
      throw new WorkspaceError(
        `two things want "${mount.dest}" in the workspace: ${clash.origin} ` +
          `(from "${clash.source}") and ${mount.origin} (from "${mount.source}"). ` +
          `One would be written inside or over the other, so heddle refuses ` +
          `rather than picking.`,
      );
    }
    claimed.push(mount);
  }
}

function overlaps(a: string, b: string): boolean {
  // Both separators, because a dest was normalized by whichever machine
  // checked it and this comparison must not depend on being that machine.
  return (
    a === b ||
    a.startsWith(`${b}/`) ||
    b.startsWith(`${a}/`) ||
    a.startsWith(`${b}\\`) ||
    b.startsWith(`${a}\\`)
  );
}
