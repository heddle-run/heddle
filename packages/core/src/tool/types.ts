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
  workspace?: string;
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
