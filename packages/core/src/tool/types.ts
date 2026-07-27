import type { JsonSchema } from '../llm/types.js';

/** ToolDef represents a discovered external tool. */
export interface ToolDef {
  name: string;
  description: string;
  path: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
}

/** ExecResult holds the result of executing an external tool. */
export interface ExecResult {
  output: Record<string, unknown>;
  stderr: string;
}

/** ExecutorScope is a group of tool calls that share one sandbox workspace. */
export interface ExecutorScope {
  executor: Executor;
  /**
   * Host path of the directory this scope's tool calls share, when the
   * executor is sandboxed.
   *
   * Named here so a caller *outside* the sandbox can put a file where the tools
   * inside it will find one. Every backend binds the workspace at its own host
   * path, so this one string is correct on both sides of the boundary — which
   * is what makes it safe to hand to a tool as an argument.
   *
   * Absent when there is no sandbox, because then there is no shared directory:
   * tools inherit heddle's cwd, and offering that as a workspace would invite
   * callers to write scratch files into the user's source tree.
   */
  workspace?: string;
  /** Tears the scope down. Safe to call more than once. */
  dispose(): void;
}

/** Executor runs external tools. */
export interface Executor {
  execute(
    signal: AbortSignal | undefined,
    toolPath: string,
    input: Record<string, unknown>,
  ): Promise<ExecResult>;

  /**
   * Opens a scope whose tool calls share one sandbox workspace, isolated from
   * every other scope. Node executors call this once per node execution so an
   * agent's tools can pass files to each other without any other agent seeing
   * them. Optional: executors without sandboxing need not implement it, and
   * callers fall back to using the executor directly.
   */
  beginScope?(label: string): ExecutorScope;
}

/** Registry holds discovered tools and provides lookup. */
export interface Registry {
  lookup(name: string): ToolDef | undefined;
  all(): ToolDef[];
}
