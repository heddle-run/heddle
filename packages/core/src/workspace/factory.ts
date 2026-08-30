import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspace, removeDir, slug } from './dir.js';
import { copyTree, stampTree, type CopyBudget } from './copy.js';
import { assertNoCollisions } from './collisions.js';
import { ScopeWorkspace, mountParent, type WritableMount } from './workspace.js';
import type {
  Mount,
  Workspace,
  WorkspaceFactory,
  WorkspaceTool,
} from './types.js';

export interface WorkspaceFactoryOptions {
  /** What every scope starts with. Validated here, copied once. */
  mounts?: Mount[];
  /**
   * A directory to put every scope's workspace under, kept after the run.
   *
   * Each scope still gets its own directory inside it, named after the node —
   * one shared directory would destroy the isolation that lets two agents in a
   * flow not see each other's files. What the flag changes is that the
   * directories survive, which is how an operator gets everything the run
   * produced without granting a single write path.
   */
  root?: string;
  budget?: CopyBudget;
  /**
   * Where a failure that must not fail the run is reported.
   *
   * Copy-back happens in the `finally` of a node's execution. A workspace that
   * threw there would replace whatever error the run was already reporting with
   * one about a directory, so it does not throw and says so here instead.
   */
  onWarn?(message: string): void;
}

export function createWorkspaceFactory(
  options: WorkspaceFactoryOptions = {},
): WorkspaceFactory {
  return new ScopedWorkspaceFactory(options);
}

/**
 * One workspace, standing alone.
 *
 * For a process that needs somewhere to write but is not a node scope: an
 * out-of-process plugin's own process is the case, and it wants a directory
 * rather than the arrangement a node's tools share. Nothing is mounted into it,
 * because nothing would read it — a confined plugin cannot see a node's
 * workspace and is told so rather than handed a path that is not there.
 */
export function createScratchWorkspace(label: string): Workspace {
  return new ScopeWorkspace({ root: createWorkspace(label), keep: false });
}

/**
 * What a factory takes from the one it extends.
 *
 * Templates rather than mounts, because the parent has already assembled them
 * and they are the same bytes for every child: an extended factory copies them
 * and never owns them. The mounts come too, but only so a collision is caught
 * and a read-only grant is still made — the copying was done upstream.
 */
interface Inherited {
  templates: string[];
  mounts: Mount[];
  /**
   * The parent's name counter, shared rather than copied.
   *
   * Under `--workspace` a scope's directory is named after its node, and the
   * counter is what stops the second arrival at a node opening the first one's
   * directory. A child with a counter of its own would hand out a name the
   * parent — or another child — had already used, which on a server is one
   * run reading another's files.
   */
  used: Map<string, number>;
}

class ScopedWorkspaceFactory implements WorkspaceFactory {
  private readonly options: WorkspaceFactoryOptions;
  private readonly readOnly: Mount[];
  private readonly writable: Mount[];
  private readonly used: Map<string, number>;
  /** Copied into every scope, in order. Only {@link template} is this one's. */
  private readonly templates: string[];
  private template?: string;

  constructor(options: WorkspaceFactoryOptions, inherited?: Inherited) {
    this.options = options;
    this.used = inherited?.used ?? new Map();

    const own = options.mounts ?? [];
    const mounts = [...(inherited?.mounts ?? []), ...own];
    assertNoCollisions(mounts);
    this.readOnly = mounts.filter((mount) => mount.mode === 'ro');
    this.writable = mounts.filter((mount) => mount.mode === 'rw');
    this.templates = [...(inherited?.templates ?? [])];

    // Assembled now rather than per scope, so a mount that is missing, too big
    // or a symlink fails before the run starts — not at whichever node reaches
    // it first, by which time the model has been told the file is there.
    //
    // Only what this factory adds: an inherited template holds the rest and
    // rebuilding it would copy the operator's mounts once per extension.
    const ownReadOnly = own.filter((mount) => mount.mode === 'ro');
    if (ownReadOnly.length > 0) {
      this.template = this.buildTemplate(ownReadOnly);
      this.templates.push(this.template);
    }
  }

  create(label: string, tools: WorkspaceTool[] = []): Workspace {
    const root = this.rootFor(label);
    for (const template of this.templates) {
      copyTree(template, root, 'workspace template');
    }

    return new ScopeWorkspace({
      root,
      keep: this.options.root !== undefined,
      readOnly: this.readOnly.map((mount) => mount.dest),
      writable: this.writable.map((mount) => this.takeWritable(root, mount)),
      tools,
      onWarn: this.options.onWarn,
    });
  }

  extend(mounts: Mount[]): WorkspaceFactory {
    return new ScopedWorkspaceFactory(
      { ...this.options, mounts },
      {
        templates: this.templates,
        mounts: [...this.readOnly, ...this.writable],
        used: this.used,
      },
    );
  }

  /** Removes what this factory assembled, and nothing it was handed. */
  dispose(): void {
    if (this.template === undefined) return;
    removeDir(this.template);
    this.template = undefined;
  }

  private buildTemplate(mounts: Mount[]): string {
    const template = mkdtempSync(join(tmpdir(), 'heddle-tpl-'));

    try {
      for (const mount of mounts) {
        copyTree(
          mount.source,
          join(template, mount.dest),
          `${mount.origin} "${mount.source}"`,
          this.options.budget,
        );
      }
    } catch (err) {
      removeDir(template);
      throw err;
    }

    return template;
  }

  /**
   * A read-write mount is copied from the host per scope, not from the
   * template.
   *
   * The operator said this directory is shared with the run, and a stale copy
   * of a shared directory is the worst of both: a node that starts after
   * another finished should see what it wrote back. The runner walks one node
   * at a time, so within a run that ordering is all there is to it.
   */
  private takeWritable(root: string, mount: Mount): WritableMount {
    const dest = join(root, mount.dest);
    mkdirSync(mountParent(root, mount), { recursive: true });

    copyTree(
      mount.source,
      dest,
      `${mount.origin} "${mount.source}"`,
      this.options.budget,
    );

    return {
      mount,
      baseline: { taken: stampTree(dest), host: stampTree(mount.source) },
    };
  }

  private rootFor(label: string): string {
    const root = this.options.root;
    if (root === undefined) return createWorkspace(label);

    const directory = join(root, this.uniqueName(label));
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  /**
   * `research-agent`, then `research-agent-2`.
   *
   * A loop can arrive at one node several times, and each arrival is its own
   * scope with its own workspace. Numbering them keeps that visible instead of
   * having the second arrival open the first one's directory and read files it
   * was not given.
   */
  private uniqueName(label: string): string {
    const base = slug(label);
    const seen = (this.used.get(base) ?? 0) + 1;
    this.used.set(base, seen);
    return seen === 1 ? base : `${base}-${seen}`;
  }
}
