import type { JsonSchema } from '../llm/types.js';

/**
 * Runs one tool that a plugin implements, rather than the filesystem.
 *
 * Not `ToolCall` — that name is taken, by the model's request to call a tool
 * (`llm/types.ts`). The two would sit in the same import block often enough
 * that one of them has to say which end it is.
 */
export type ToolHandler = (
  signal: AbortSignal | undefined,
  input: Record<string, unknown>,
) => Promise<ExecResult>;

/**
 * How a tool runs, as a closed union rather than a set of optional fields.
 *
 * `ToolDef.path` used to be a required string, and every consumer read it and
 * handed it to `Executor.execute`. That is a fine description of a directory of
 * executables and no description at all of a tool an MCP proxy provides, which
 * exists nowhere on the filesystem. The obvious repair — make `path` optional
 * and add a `call` beside it — produces a type where two fields both claim to
 * say how a tool runs and nothing says which, so every consumer has to
 * rediscover the precedence. A union makes the answer singular and makes the
 * compiler name every place that has to know.
 */
export type ToolImpl =
  /** An executable on disk, spawned by an {@link Executor}. */
  | { kind: 'path'; path: string }
  /** Implemented by the plugin that declared it, reached over its own channel. */
  | { kind: 'plugin'; plugin: string; call: ToolHandler };


/** ToolDef represents a discovered external tool. */
export interface ToolDef {
  name: string;
  description: string;
  impl: ToolImpl;
  /**
   * Where this tool came from, for a message that has to tell two of them
   * apart: `dir:/opt/tools`, `plugin:mcp-github`. Only ever read by humans —
   * nothing routes on it.
   */
  origin?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  /**
   * Whether this tool may share a name with one from another source.
   *
   * Only a plugin's tools set it, and only a manifest can ask for it. It is
   * read by {@link composeRegistries}, which is the one place two sources meet.
   */
  shadows?: boolean;
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
