import type { ExecResult, Executor, ToolDef } from './types.js';
import { ToolError } from '../errors.js';

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
    throw new ToolError(missingExecutorMessage(tool.name, tool.impl.path));
  }
  return executor.execute(signal, tool.impl.path, input);
}

function missingExecutorMessage(name: string, path: string): string {
  return (
    `tool "${name}" is an executable at ${path}, and no tool ` +
    `executor is configured to run it.`
  );
}
