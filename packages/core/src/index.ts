/**
 * Public API of the engine.
 *
 * This package is deliberately free of any CLI or terminal-UI dependency: it
 * parses Agent Spec flows, compiles them into an executable graph, and runs
 * them. Anything user-facing — progress output, prompts, colours — belongs to a
 * consumer, which observes execution through {@link EventHandler}.
 */

// ---------------------------------------------------------------------------
// Spec: parsing, loading, validation
// ---------------------------------------------------------------------------

export {
  parseFlow,
  parseFlowYaml,
  parseAgent,
  parseComponent,
  parseComponentJson,
  parseComponentYaml,
} from './spec/parser.js';

export { loadFlow, loadComponent } from './spec/load.js';

export { validateFlow, validateAgent } from './spec/validate.js';

export { collectToolNames, propertyTitle } from './spec/types.js';

export type {
  Agent,
  AgentNode,
  BranchingNode,
  ControlFlowEdge,
  DataFlowEdge,
  EndNode,
  Flow,
  LLMConfig,
  LLMNode,
  ParsedFlow,
  Property,
  SpecNode,
  StartNode,
  ToolNode,
  ToolSpec,
} from './spec/types.js';

// ---------------------------------------------------------------------------
// Graph: compilation and structural validation
// ---------------------------------------------------------------------------

export { compile } from './graph/compile.js';
export { validate } from './graph/validate.js';
export { CompiledGraph } from './graph/types.js';
export type { CompiledNode, DataSource } from './graph/types.js';

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export { Runner } from './runner/runner.js';
export { DEFAULT_RUNNER_OPTIONS } from './runner/options.js';
export type { RunnerOptions } from './runner/options.js';
export type { Event, EventType, EventHandler } from './runner/events.js';

export { State } from './state/state.js';

export type { Dependencies, NodeExecutor } from './node/types.js';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export { FileRegistry } from './tool/registry.js';
export { SubprocessExecutor } from './tool/executor.js';
export type { Executor, ExecResult, Registry, ToolDef } from './tool/types.js';

// ---------------------------------------------------------------------------
// LLM providers
// ---------------------------------------------------------------------------

export { createProvider } from './llm/provider.js';
export type {
  ChatRequest,
  ChatResponse,
  JsonSchema,
  Message,
  Provider,
  Role,
  ToolCall,
  ToolDefinition,
} from './llm/types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  CompileError,
  LLMError,
  RunError,
  SpecError,
  ToolError,
} from './errors.js';
