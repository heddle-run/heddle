import type { JsonSchema } from '../llm/types.js';

export type ToolHandler = (
  signal: AbortSignal | undefined,
  input: Record<string, unknown>,
) => Promise<ExecResult>;

export type ToolImpl =
  | { kind: 'path'; path: string }
  | { kind: 'plugin'; plugin: string; call: ToolHandler };

export interface ToolDef {
  name: string;
  description: string;
  impl: ToolImpl;
  origin?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  shadows?: boolean;
}

export interface ExecResult {
  output: Record<string, unknown>;
  stderr: string;
}

export interface ExecutorScope {
  executor: Executor;
  /**
   * Where this scope's tools work, and where they hand each other files.
   *
   * Not optional. A scope that cannot say where its work happens is a scope
   * nothing can pass a file through, and it used to be absent for exactly one
   * reason — no sandbox — which made a plugin node's behaviour depend on a flag
   * it has no business knowing about.
   */
  workspace: string;
  dispose(): void;
}

export interface Executor {
  execute(
    signal: AbortSignal | undefined,
    toolPath: string,
    input: Record<string, unknown>,
  ): Promise<ExecResult>;

  beginScope?(label: string): ExecutorScope;
}

export interface Registry {
  lookup(name: string): ToolDef | undefined;
  all(): ToolDef[];
}
