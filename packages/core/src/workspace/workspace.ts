import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { removeDir } from './dir.js';
import type { Workspace, WorkspaceGrant } from './types.js';

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
}

export class ScopeWorkspace implements Workspace {
  readonly root: string;
  readonly bin: string;

  private readonly keep: boolean;

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
    this.keep = options.keep;

    mkdirSync(this.bin, { recursive: true });
  }

  /**
   * The root writable, and `.heddle` read-only inside it.
   *
   * Order matters and is the reason this is a list rather than two fields: both
   * backends resolve a nested grant by taking the later one, so the read-only
   * half has to come after the writable half it sits inside. Without it,
   * `echo evil > $HEDDLE_WORKSPACE/.heddle/bin/read_file` rewrites a tool and
   * heddle runs it on the next call.
   */
  grants(): WorkspaceGrant[] {
    return [
      { path: this.root, access: 'write' },
      { path: join(this.root, RESERVED_DIR), access: 'read' },
    ];
  }

  dispose(): void {
    if (this.keep) return;
    removeDir(this.root);
  }
}
