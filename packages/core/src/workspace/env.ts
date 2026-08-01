import type { Workspace } from './types.js';

/**
 * What a tool is told about its workspace.
 *
 * `basePath` is what `$PATH` would have been: the sandbox's own fixed list when
 * one is configured, and whatever this process inherited when one is not.
 *
 * **`bin` goes last, and that is the whole of the decision.** First was the
 * obvious choice and is wrong: heddle's own tools are named after what they do,
 * so a flow with a tool called `bash` — which the shipped examples have — would
 * put a JSON-on-stdin script where every other tool's `bash -c` expects the
 * shell. The same goes for `python3`, `curl`, `git`. Last means a tool reaches a
 * peer by name and nothing the system already provides is quietly replaced;
 * what it costs is the ability to override a system binary, which is not
 * something to do by accident and can still be done with a wrapper.
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
        ? `${basePath}:${workspace.bin}`
        : workspace.bin,
  };
}
