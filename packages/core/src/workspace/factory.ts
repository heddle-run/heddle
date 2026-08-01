import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspace, slug } from './dir.js';
import { ScopeWorkspace } from './workspace.js';
import type { Workspace, WorkspaceFactory } from './types.js';

export interface WorkspaceFactoryOptions {
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

class ScopedWorkspaceFactory implements WorkspaceFactory {
  private readonly options: WorkspaceFactoryOptions;
  private readonly used = new Map<string, number>();

  constructor(options: WorkspaceFactoryOptions) {
    this.options = options;
  }

  create(label: string): Workspace {
    const root = this.options.root;
    if (root === undefined) {
      return new ScopeWorkspace({ root: createWorkspace(label), keep: false });
    }

    const directory = join(root, this.uniqueName(label));
    mkdirSync(directory, { recursive: true });
    return new ScopeWorkspace({ root: directory, keep: true });
  }

  dispose(): void {
    return;
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
