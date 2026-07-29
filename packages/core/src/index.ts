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
// `EventType` is half closed and half open, and both halves are named here
// because a consumer's first question about an event is which half it came
// from. `isPluginEvent` answers it and `PLUGIN_EVENT_PREFIX` is what a consumer
// strips to get back to the plugin's own name. What is deliberately *not*
// exported is `pluginEventType`, the function that mints one: heddle deciding
// the wire type is the whole of why a plugin cannot forge a builtin event, and
// that stops being true the moment anything else can call it.
export type {
  BuiltinEventType,
  Event,
  EventType,
  EventHandler,
  LogLevel,
  PluginEventType,
} from './runner/events.js';
export { isPluginEvent, PLUGIN_EVENT_PREFIX } from './runner/events.js';

export { State } from './state/state.js';

export type { Dependencies, NodeExecutor } from './node/types.js';

// ---------------------------------------------------------------------------
// Plugins: custom Agent Spec component types
// ---------------------------------------------------------------------------

export { definePlugin } from './plugin/types.js';
export { PluginRegistry } from './plugin/registry.js';
export type { ComponentKind, RegisteredMiddleware } from './plugin/registry.js';
export { loadPlugin, loadPlugins } from './plugin/loader.js';

// ---------------------------------------------------------------------------
// Middleware: interception rather than a slot
//
// The one kind a spec cannot name. Whoever runs heddle installs it and it is
// consulted at a seam — a call site the engine has, which no document could
// have pointed at. `nodeError` is the seam wired today.
// ---------------------------------------------------------------------------

export { MiddlewareChain, MiddlewareError, MAX_RETRY_DELAY } from './plugin/middleware.js';
export type { ChainVerdict } from './plugin/middleware.js';
export { SEAMS, SEAM_NAMES, IMPLEMENTED_SEAMS, isSeam } from './plugin/seams.js';
export type {
  AfterAction,
  BeforeAction,
  Half,
  Seam,
  SeamDef,
  SeamSubscription,
} from './plugin/seams.js';

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
export type {
  CallOptions,
  ModelCaller,
  PartialHandler,
  PluginHostOptions,
  ToolRunner,
} from './plugin/host.js';
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
  isLogLevel,
  isPluginCapability,
  isPluginMethod,
  isRequest,
  LineDecoder,
  LOG_LEVELS,
  PLUGIN_CAPABILITIES,
  PLUGIN_METHODS,
  PROTOCOL_VERSION,
  readAfterVerdict,
  readModelRequest,
  spokenProtocol,
} from './plugin/protocol.js';
export type {
  AfterParams,
  AfterVerdict,
  ApplyParams,
  CallModelParams,
  CancelParams,
  EmitEventParams,
  ExecuteParams,
  HostLifecycleMethods,
  HostMethod,
  HostMethods,
  HostVerb,
  HostVerbs,
  InitParams,
  InitResult,
  LogParams,
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
  MiddlewareContext,
  MiddlewareSubject,
  PluginComponent,
  PluginComponentDef,
  PluginContext,
  PluginIO,
  PluginMiddlewareDef,
  PluginMiddlewareExecutor,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginReporter,
  PluginResult,
  PluginServices,
  PluginTransformDef,
  PluginTransformExecutor,
  SeamOutcome,
  TransformContext,
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

export { createProvider, generationParams } from './llm/provider.js';
export type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  JsonSchema,
  Message,
  ModelRequest,
  Provider,
  ResponseFormat,
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
