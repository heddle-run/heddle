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
