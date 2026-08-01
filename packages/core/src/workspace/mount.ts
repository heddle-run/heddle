import { existsSync, realpathSync } from 'node:fs';
import { basename, isAbsolute, normalize, resolve, sep } from 'node:path';
import { WorkspaceError } from '../errors.js';
import { RESERVED_DIR } from './workspace.js';
import type { Mount, MountMode } from './types.js';

export const DEFAULT_MOUNT_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MOUNT_MAX_ENTRIES = 4096;

const MODES = new Set<string>(['ro', 'rw']);
const FLAG = '--mount';

/**
 * `<src>`, `<src>:<dest>`, `<src>:<dest>:<mode>`, `<src>::<mode>`.
 *
 * Read right to left, because a source path may contain a colon and a mode may
 * not: if the last field is `ro` or `rw` it is the mode, and if what is left
 * has a colon the part after the last one is the destination. A source called
 * `a:b` with no destination still parses, and one called `a:ro` is the case
 * this cannot get right — which is why the two-field form is documented as the
 * way to be explicit.
 */
export function parseMount(spec: string): Mount {
  const trimmed = spec.trim();
  if (trimmed.length === 0) {
    throw new WorkspaceError(`${FLAG} was given nothing to mount`);
  }

  let rest = trimmed;
  let mode: MountMode = 'ro';
  let dest: string | undefined;

  const lastColon = rest.lastIndexOf(':');
  if (lastColon > 0 && MODES.has(rest.slice(lastColon + 1))) {
    mode = rest.slice(lastColon + 1) as MountMode;
    rest = rest.slice(0, lastColon);
  }

  const destColon = rest.lastIndexOf(':');
  if (destColon > 0) {
    dest = rest.slice(destColon + 1);
    rest = rest.slice(0, destColon);
  }

  return checkedMount({
    source: rest,
    dest: dest !== undefined && dest.length > 0 ? dest : basename(rest),
    mode,
    origin: FLAG,
  });
}

/**
 * Everything that can be known about a mount before anything is copied.
 *
 * Checked here rather than when a scope opens, so a typo fails at second zero
 * instead of at whichever node reaches it first — by which time the model has
 * been told the file is there.
 */
export function checkedMount(mount: Mount): Mount {
  const source = resolve(mount.source);

  if (!existsSync(source)) {
    throw new WorkspaceError(
      `${mount.origin}: "${mount.source}" is not there. A mount is copied into ` +
        `the workspace before the run starts, so it has to exist now.`,
    );
  }

  return { ...mount, source: realpathSync(source), dest: checkedDest(mount) };
}

function checkedDest(mount: Mount): string {
  const dest = mount.dest.trim();

  if (dest.length === 0) {
    throw new WorkspaceError(
      `${mount.origin}: "${mount.source}" has an empty destination.`,
    );
  }
  if (isAbsolute(dest)) {
    throw new WorkspaceError(
      `${mount.origin}: "${dest}" is an absolute path. A destination says where ` +
        `inside the workspace something lands, so it is relative to the ` +
        `workspace root.`,
    );
  }

  const normalized = normalize(dest);
  if (normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new WorkspaceError(
      `${mount.origin}: "${dest}" climbs out of the workspace. Mounting outside ` +
        `it would put the files somewhere the run's own guarantees do not reach.`,
    );
  }
  if (normalized === RESERVED_DIR || normalized.startsWith(`${RESERVED_DIR}${sep}`)) {
    throw new WorkspaceError(
      `${mount.origin}: "${dest}" is under "${RESERVED_DIR}", which heddle ` +
        `reserves — it holds the tools, and it is read-only so a tool cannot ` +
        `rewrite a peer. Choose another name.`,
    );
  }

  return normalized;
}

/**
 * Refuse two mounts that would land on top of each other.
 *
 * By prefix rather than by string equality, so `skills` and `skills/extra`
 * collide: the second would be written inside the first, and which one a tool
 * then reads depends on the order they were copied. Naming both origins matters
 * because one of them is often a plugin the operator did not write.
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
  return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
}
