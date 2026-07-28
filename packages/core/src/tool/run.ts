/**
 * The one way a name in a spec becomes a running tool.
 *
 * Four callers reach the tool registry — an agent's tool-calling loop, a
 * ToolNode, an in-process plugin's `ctx.runTool`, and the reverse call an
 * out-of-process plugin makes — and every one of them wants the same three
 * steps: check the wiring, look the name up, run it and hand back the output.
 * They had four copies of those steps, which is four chances for one of them to
 * report a missing registry as a missing tool, or to drop the run's signal.
 *
 * What legitimately differs between them is who is at fault when it goes wrong,
 * so that is the parameter: `where` names the component, and nothing else about
 * the call site has to be repeated.
 */
import type { Executor, Registry } from './types.js';
import { RunError, ToolError } from '../errors.js';

/** The tool half of {@link import('../node/types.js').Dependencies}. */
export interface ToolAccess {
  toolRegistry?: Registry;
  toolExecutor?: Executor;
}

/**
 * What this particular call knows that the compiled graph does not.
 *
 * `executor` is the scoped one, when the caller opened a scope: a node's tools
 * share that scope's workspace, and running through the graph-wide executor
 * instead would put each tool in a throwaway sandbox session that sees none of
 * it. Callers with no scope of their own — a transform, a plugin that
 * hand-rolls the protocol — pass nothing and get the graph-wide executor, which
 * is all they ever had.
 */
export interface ToolCall {
  executor?: Executor;
  signal?: AbortSignal;
}

export async function runRegisteredTool(
  deps: ToolAccess,
  call: ToolCall | undefined,
  name: string,
  input: Record<string, unknown>,
  where: string,
): Promise<Record<string, unknown>> {
  if (!deps.toolRegistry) {
    throw new RunError(`${where}: no tool registry configured`);
  }
  const executor = call?.executor ?? deps.toolExecutor;
  if (!executor) {
    throw new RunError(`${where}: no tool executor configured`);
  }

  const tool = deps.toolRegistry.lookup(name);
  if (!tool) {
    throw new ToolError(`${where}: tool "${name}" not found`);
  }

  const result = await executor.execute(call?.signal, tool.path, input);
  return result.output;
}
