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

/** Executor runs external tools. */
export interface Executor {
  execute(
    signal: AbortSignal | undefined,
    toolPath: string,
    input: Record<string, unknown>,
  ): Promise<ExecResult>;
}

/** Registry holds discovered tools and provides lookup. */
export interface Registry {
  lookup(name: string): ToolDef | undefined;
  all(): ToolDef[];
}
