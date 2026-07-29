/**
 * The one place heddle decides how a tool runs.
 *
 * Before this there were four, and they were four copies of one line —
 * `executor.execute(signal, toolDef.path, input)` in `node/agent.ts`,
 * `node/tool.ts`, `plugin/executor.ts` and `plugin/services.ts`. Four copies of
 * a decision is survivable while there is only one answer; the moment a tool
 * can be something other than a path, it is four places that each have to learn
 * the same new rule and four places that can learn it differently.
 *
 * So the branch lives here and the call sites lose their opinion. What they
 * keep is what is genuinely theirs: which signal bounds the call, and which
 * executor — a node hands over the scoped one it opened, so its tools share a
 * workspace, and that is a fact about the node, not about the tool.
 */
import type { ExecResult, Executor, ToolDef } from './types.js';
import { ToolError } from '../errors.js';

/**
 * Run one tool, however it happens to be implemented.
 *
 * `executor` is optional because a plugin-implemented tool needs none, and that
 * is not a detail: a flow whose every tool comes from a plugin runs without a
 * tools directory, without a subprocess and without the executable bit, which
 * is the whole point of the kind. The executor is required only when the tool
 * turns out to be a path, so the check lives after the branch — demanding one
 * up front would refuse a run that needs nothing from it.
 */
export async function invokeTool(
  signal: AbortSignal | undefined,
  tool: ToolDef,
  input: Record<string, unknown>,
  executor: Executor | undefined,
): Promise<ExecResult> {
  if (tool.impl.kind === 'plugin') {
    return tool.impl.call(signal, input);
  }

  if (!executor) {
    throw new ToolError(
      `tool "${tool.name}" is an executable at ${tool.impl.path}, and no tool ` +
        `executor is configured to run it.`,
    );
  }
  return executor.execute(signal, tool.impl.path, input);
}
