import type { Workspace } from './types.js';

/**
 * What a tool is told about its workspace.
 *
 * `basePath` is what `$PATH` would have been: the sandbox's own fixed list when
 * one is configured, and whatever this process inherited when one is not. The
 * workspace's `bin` goes first either way, so a tool named `python3` shadows
 * the system one — which may be exactly what the operator installed it for, so
 * it is reported rather than refused.
 */
export function workspaceEnv(
  workspace: Workspace,
  basePath: string | undefined,
): Record<string, string> {
  return {
    HEDDLE_WORKSPACE: workspace.root,
    HEDDLE_WORKSPACE_BIN: workspace.bin,
    PATH:
      basePath !== undefined && basePath.length > 0
        ? `${workspace.bin}:${basePath}`
        : workspace.bin,
  };
}
