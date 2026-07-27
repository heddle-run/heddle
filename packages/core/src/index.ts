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
  AnyNode,
  CustomNode,
  ParsedFlow,
  Property,
  SpecNode,
  TransformSpec,
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
// Plugins: custom Agent Spec component types
// ---------------------------------------------------------------------------

export { definePlugin } from './plugin/types.js';
export { PluginRegistry } from './plugin/registry.js';
export type { ComponentKind } from './plugin/registry.js';
export { loadPlugin, loadPlugins } from './plugin/loader.js';

// ---------------------------------------------------------------------------
// Out-of-process plugins
//
// The same component types, executed in their own process. A plugin loaded this
// way cannot read the server's environment, cannot leave state behind for the
// next run, and cannot take the server down with it — none of which the
// in-process path above can offer, because there a plugin *is* the server.
// ---------------------------------------------------------------------------

export { loadRemotePlugin, readManifest } from './plugin/remote-loader.js';
export type { RemotePlugin, RemotePluginOptions } from './plugin/remote-loader.js';
export { PluginHost } from './plugin/host.js';
export type { PartialHandler, PluginHostOptions, ToolRunner } from './plugin/host.js';
// The wire protocol itself, for anyone writing the plugin end of it in
// TypeScript: these are the shapes a plugin has to read and produce, and they
// are worth having checked rather than transcribed from the docs.
// `PROTOCOL_VERSION` is the one value a plugin must not transcribe — it is the
// number the plugin answers `init` with, compatibility is equality, and a
// literal copied into a plugin is a literal that stops matching on the day this
// one moves.
export {
  encode,
  hostRequest,
  isPartial,
  isPluginCapability,
  isPluginMethod,
  isRequest,
  LineDecoder,
  PLUGIN_CAPABILITIES,
  PLUGIN_METHODS,
  PROTOCOL_VERSION,
  spokenProtocol,
} from './plugin/protocol.js';
export type {
  ApplyParams,
  CancelParams,
  ExecuteParams,
  HostLifecycleMethods,
  HostMethod,
  HostMethods,
  HostVerb,
  HostVerbs,
  InitParams,
  InitResult,
  PluginCapability,
  PluginMethod,
  PluginMethods,
  RpcMessage,
  RpcPartial,
  RpcRequest,
  RpcResponse,
  RunToolParams,
  ShutdownParams,
} from './plugin/protocol.js';
export { PLUGIN_RUNTIME_JS, withRuntime } from './plugin/runtime-source.js';
export { validateManifest } from './plugin/manifest.js';
export type {
  PluginManifest,
  ManifestComponent,
  JsonSchemaFragment,
} from './plugin/manifest.js';
export { checkSchema } from './plugin/schema.js';
export type {
  HeddlePlugin,
  PluginComponent,
  PluginComponentDef,
  PluginContext,
  PluginIO,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginResult,
  PluginTransformDef,
  PluginTransformExecutor,
  TransformPhase,
  TransformResult,
} from './plugin/types.js';

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export { FileRegistry } from './tool/registry.js';
export { SubprocessExecutor } from './tool/executor.js';
export type { SubprocessExecutorOptions } from './tool/executor.js';
export type {
  Executor,
  ExecResult,
  ExecutorScope,
  Registry,
  ToolDef,
} from './tool/types.js';

// ---------------------------------------------------------------------------
// Sandboxing: confining tool subprocesses
// ---------------------------------------------------------------------------

export { createSandbox, DEFAULT_SANDBOX_POLICY } from './sandbox/index.js';
export type {
  Sandbox,
  SandboxBackend,
  SandboxCommand,
  SandboxPolicy,
  SandboxSession,
} from './sandbox/index.js';

// ---------------------------------------------------------------------------
// LLM providers
//
// `Provider` is the interface a provider plugin implements, so its streaming
// half belongs here with it. `ChatChunk` is the shape every implementation
// yields and `ToolCallDelta` the shape inside it that is easiest to get wrong:
// a provider that has to transcribe them from prose instead of importing them
// will key tool-call fragments by `id` — which looks right against a
// single-tool transcript and silently concatenates two calls into one against a
// real one.
// ---------------------------------------------------------------------------

export { createProvider } from './llm/provider.js';
export type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  JsonSchema,
  Message,
  Provider,
  Role,
  ToolCall,
  ToolCallDelta,
  ToolDefinition,
} from './llm/types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export {
  CompileError,
  LLMError,
  PluginError,
  RunError,
  SandboxError,
  SpecError,
  ToolError,
} from './errors.js';
