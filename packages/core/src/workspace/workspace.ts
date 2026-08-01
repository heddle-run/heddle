import { mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { removeDir } from './dir.js';
import { copyBack, type MountBaseline } from './copy.js';
import { fillBin } from './bin.js';
import type {
  Mount,
  Workspace,
  WorkspaceGrant,
  WorkspaceTool,
} from './types.js';

/**
 * The one name reserved inside a workspace, and it is hidden.
 *
 * Hidden because the model lists its workspace constantly and what it is
 * looking for is its own files. One reserved name rather than two — `bin` and
 * `files` at the root are both names an operator would plausibly mount and the
 * model would plausibly create, and a layout that reserves plausible names is a
 * layout that collides.
 */
export const RESERVED_DIR = '.heddle';

/** A read-write mount, and what it looked like when this scope copied it in. */
export interface WritableMount {
  mount: Mount;
  baseline: MountBaseline;
}

export interface ScopeWorkspaceOptions {
  root: string;
  /**
   * Whether `dispose` removes the root.
   *
   * False when the operator named the directory with `--workspace`: keeping
   * what the run produced is the whole point of the flag, and heddle deleting a
   * directory somebody else chose is not a thing it should ever do.
   */
  keep: boolean;
  /** Read-only mount destinations, relative to the root. */
  readOnly?: string[];
  writable?: WritableMount[];
  /** Put in `bin`, and first on `$PATH`. */
  tools?: WorkspaceTool[];
  onWarn?(message: string): void;
}

export class ScopeWorkspace implements Workspace {
  readonly root: string;
  readonly bin: string;

  private readonly options: ScopeWorkspaceOptions;
  private readonly reachable: string[];

  constructor(options: ScopeWorkspaceOptions) {
    mkdirSync(options.root, { recursive: true });

    // Resolved once, here, so that every reader agrees: the cwd a backend
    // hands the process, the `$HEDDLE_WORKSPACE` it reads, the grants a profile
    // is built from, and the `realpath` a tool script does before deciding
    // whether a path is inside. `mkdtemp` in `/var` on macOS is really
    // `/private/var`, and a workspace that reports one while the process sits
    // in the other makes every confinement check disagree with itself.
    this.root = realpathSync(options.root);
    this.bin = join(this.root, RESERVED_DIR, 'bin');
    this.options = options;

    mkdirSync(this.bin, { recursive: true });
    this.reachable = fillBin(this.bin, options.tools ?? []);
  }

  toolPaths(): string[] {
    return [...this.reachable];
  }

  /**
   * The root writable, then everything read-only that sits inside it.
   *
   * Order matters and is the reason this is a list rather than two fields: both
   * backends resolve a nested grant by taking the later one, so the read-only
   * half has to come after the writable half it sits inside. Without it,
   * `echo evil > $HEDDLE_WORKSPACE/.heddle/bin/read_file` rewrites a tool and
   * heddle runs it on the next call, and a `ro` mount is only a copy the run
   * happens not to have edited yet.
   */
  grants(): WorkspaceGrant[] {
    return [
      { path: this.root, access: 'write' },
      { path: join(this.root, RESERVED_DIR), access: 'read' },
      ...(this.options.readOnly ?? []).map((dest) => ({
        path: join(this.root, dest),
        access: 'read' as const,
      })),
    ];
  }

  dispose(): void {
    for (const writable of this.options.writable ?? []) this.putBack(writable);
    if (this.options.keep) return;
    removeDir(this.root);
  }

  /**
   * Never throws.
   *
   * `dispose` runs in the `finally` of a node's execution. A workspace that
   * threw there would replace whatever error the run was already reporting with
   * one about a directory, and the run's own error is the one worth having.
   */
  private putBack(writable: WritableMount): void {
    const { mount } = writable;
    const from = join(this.root, mount.dest);

    try {
      const result = copyBack(from, mount.source, writable.baseline);

      for (const path of result.overwritten) {
        this.warn(
          `${join(mount.dest, path)} changed on disk while the run was using it, ` +
            `and the run's version was written over it. The last writer wins ` +
            `and this run was it.`,
        );
      }
    } catch (err) {
      this.warn(
        `could not copy "${mount.dest}" back to "${mount.source}": ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private warn(message: string): void {
    this.options.onWarn?.(`workspace: ${message}`);
  }
}

/** Where a mount's destination lives inside a workspace root. */
export function mountPath(root: string, mount: Mount): string {
  return join(root, mount.dest);
}

/** The directory a mount's destination needs to exist in. */
export function mountParent(root: string, mount: Mount): string {
  return dirname(join(root, mount.dest));
}
