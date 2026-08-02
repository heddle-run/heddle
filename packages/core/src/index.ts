export {
  parseFlow,
  parseFlowObject,
  parseFlowWith,
  parseFlowYaml,
  parseAgent,
  parseComponent,
  parseComponentJson,
  parseComponentWith,
  parseComponentYaml,
} from './spec/parser.js';

export { loadFlow, loadComponent } from './spec/load.js';
export type { LoadOptions } from './spec/load.js';

// The input side of the wire: how a spec document reaches heddle as text.
// Everything downstream of `InputFormatDef.parse` is format-blind, so a new
// format — a plugin's or an embedder's — adapts at this seam and nothing else.
export {
  BUILTIN_INPUT_FORMATS,
  INPUT_FORMAT_NAME,
  JSON_INPUT_FORMAT,
  YAML_INPUT_FORMAT,
  inputFormatByName,
  inputFormatForPath,
} from './spec/input-format.js';
export type { InputFormatDef } from './spec/input-format.js';

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

export { compile } from './graph/compile.js';
export { validate } from './graph/validate.js';
export { CompiledGraph } from './graph/types.js';
export type { CompiledNode, DataSource } from './graph/types.js';

export { Runner } from './runner/runner.js';
export { runFlow } from './run-flow.js';
export type { RunFlowOptions } from './run-flow.js';
export { DEFAULT_RUNNER_OPTIONS } from './runner/options.js';
export type {
  CheckpointSink,
  RunnerOptions,
  RunPosition,
  SuspensionRecord,
} from './runner/options.js';
export type {
  BuiltinEventType,
  Event,
  EventType,
  EventHandler,
  LogLevel,
  PluginEventType,
} from './runner/events.js';
export {
  EVENT_CONTRACT_VERSION,
  isPluginEvent,
  PLUGIN_EVENT_PREFIX,
} from './runner/events.js';

export { State } from './state/state.js';

export {
  CHAT_HISTORY_KEY,
  RESERVED_STATE_KEYS,
  RESUME_KEY,
  isReservedStateKey,
  withoutReserved,
} from './session/reserved.js';
export { historyMessages, readHistory } from './session/history.js';
export type { HistoryMessage } from './session/history.js';
export {
  RunSuspended,
  isSuspended,
  readResume,
  resumeInputs,
} from './session/suspend.js';
export type { ResumePayload } from './session/suspend.js';
export {
  assertSessionId,
  isBusy,
  newSessionId,
  type SessionStore,
} from './session/store.js';
export { FileSessionStore } from './session/file-store.js';
export type { FileSessionStoreOptions } from './session/file-store.js';
export {
  answerOf,
  closeTurn,
  historyFromTurns,
  openTurn,
  resumeTurn,
  transcriptOf,
} from './session/turn.js';
export type {
  OpenedTurn,
  OpenTurnOptions,
  ResumedTurn,
  TurnOutcome,
} from './session/turn.js';
export {
  checkpointFrom,
  checkpointSink,
  positionOf,
} from './session/checkpoint.js';
export type { CheckpointOptions } from './session/checkpoint.js';
export type {
  Checkpoint,
  ListOptions,
  SessionRecord,
  SessionSummary,
  Suspension,
  Turn,
} from './session/types.js';

export type { Dependencies, NodeExecutor } from './node/types.js';

export { definePlugin } from './plugin/types.js';
export { PluginRegistry, SUBMITTABLE_KINDS } from './plugin/registry.js';
export type { ComponentKind, RegisteredMiddleware } from './plugin/registry.js';
export {
  loadPlugin,
  loadPlugins,
  type LoadPluginsOptions,
} from './plugin/loader.js';
export { parsePluginConfig } from './plugin/config.js';

export {
  MiddlewareChain,
  MiddlewareError,
  checkMiddlewareConfig,
  MAX_RETRY_DELAY,
} from './plugin/middleware.js';
export type { ChainBefore, ChainVerdict } from './plugin/middleware.js';
export { SEAMS, SEAM_NAMES, isSeam } from './plugin/seams.js';
export type {
  AfterAction,
  BeforeAction,
  Half,
  Seam,
  SeamDef,
  SeamSubscription,
} from './plugin/seams.js';

export {
  loadRemotePlugin,
  readManifest,
  remotePlugin,
} from './plugin/remote-loader.js';
export type { RemotePlugin, RemotePluginOptions } from './plugin/remote-loader.js';
export { PluginHost } from './plugin/host.js';
export type {
  CallOptions,
  ModelCaller,
  PartialHandler,
  PluginHostOptions,
  ToolRunner,
} from './plugin/host.js';
export {
  encode,
  hostRequest,
  isPartial,
  isLogLevel,
  isPluginMethod,
  isRequest,
  LineDecoder,
  LOG_LEVELS,
  PLUGIN_METHODS,
  PROTOCOL_VERSION,
  readAfterVerdict,
  readChatChunk,
  readChatResponse,
  readModelRequest,
  readWireFrames,
  spokenProtocol,
} from './plugin/protocol.js';
export type {
  AfterParams,
  AfterVerdict,
  SeamSubject,
  ApplyParams,
  BeforeParams,
  BeforeVerdict,
  CallModelParams,
  CancelParams,
  ChatParams,
  EmitEventParams,
  EncodeParams,
  ExecuteParams,
  FinishEncodeParams,
  HostLifecycleMethods,
  HostMethod,
  HostMethods,
  HostVerb,
  HostVerbs,
  InitParams,
  InitResult,
  LogParams,
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
  ManifestFile,
  ManifestKind,
  ManifestTool,
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
  PluginEncoder,
  PluginEncoderDef,
  PluginIO,
  PluginMiddlewareDef,
  PluginMiddlewareExecutor,
  PluginNode,
  PluginNodeDef,
  PluginNodeExecutor,
  PluginProviderDef,
  PluginStoreDef,
  PluginReporter,
  PluginResult,
  PluginServices,
  PluginTransformDef,
  PluginTransformExecutor,
  SeamOutcome,
  TransformContext,
  TransformPhase,
  TransformResult,
  WireFrame,
  WorkspaceFile,
} from './plugin/types.js';

export {
  builtinEncoder,
  BUILTIN_PROTOCOL,
  encoderFor,
  EncoderStream,
  PROTOCOL_NAME,
  serializeEvent,
} from './plugin/encoder.js';
export type { ResolvedEncoder } from './plugin/encoder.js';

export {
  composeRegistries,
  FileRegistry,
  missingTools,
} from './tool/registry.js';
export { invokeTool } from './tool/invoke.js';
export { SubprocessExecutor } from './tool/executor.js';
export type { SubprocessExecutorOptions } from './tool/executor.js';
export type {
  Executor,
  ExecResult,
  ExecutorScope,
  Registry,
  ToolDef,
  ToolHandler,
  ToolImpl,
} from './tool/types.js';

export { createSandbox, DEFAULT_SANDBOX_POLICY } from './sandbox/index.js';
export type {
  Sandbox,
  SandboxBackend,
  SandboxCommand,
  SandboxPolicy,
  SandboxSession,
} from './sandbox/index.js';

// Where a node's tools work, and what is in there when they start. Separate
// from the sandbox on purpose: a workspace exists on every run, and `--safe`
// decides only whether anything enforces its edges.
export {
  createScratchWorkspace,
  createWorkspaceFactory,
  parseMount,
  checkedDest,
  checkedMount,
  workspaceTools,
  DEFAULT_MOUNT_MAX_BYTES,
  DEFAULT_MOUNT_MAX_ENTRIES,
  RESERVED_DIR as WORKSPACE_RESERVED_DIR,
} from './workspace/index.js';

// The run environment as both surfaces build it: the sandbox, the workspaces,
// the registry a run resolves its tools against. One definition, so what a
// flag means does not depend on which binary parsed it.
export {
  assertNoSandboxTuning,
  assertToolsAvailable,
  DEFAULT_SANDBOX_BACKEND,
  positiveOption,
  SANDBOX_BACKENDS,
  sandboxFromOptions,
  standardRegistry,
  workspacesFromOptions,
} from './runenv.js';
export type { SandboxOptions, WorkspaceOptions } from './runenv.js';
export type {
  CopyBudget,
  Mount,
  MountMode,
  Workspace,
  WorkspaceFactory,
  WorkspaceFactoryOptions,
  WorkspaceGrant,
  WorkspaceTool,
} from './workspace/index.js';

export {
  createProvider,
  generationParams,
  isBuiltinConfigType,
  providerFor,
} from './llm/provider.js';
export type { ProviderOptions } from './llm/provider.js';
// The egress policy, which decides where a spec heddle did not write may send
// heddle's own requests. Exported because an embedder accepting submitted specs
// needs the same rule the server applies.
export { assertEgressAllowed, isPrivateHost } from './llm/egress.js';
export type { EgressPolicy } from './llm/egress.js';
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

// The `.heddle` bundle: a flow and everything it runs with, in one gzipped tar
// a stock `tar -xzf` can open. Exported so the CLI packs and opens them with
// the same code, and so an embedder taking bundles applies the same checks.
export {
  BUNDLE_EXTENSION,
  BUNDLE_FORMAT,
  BUNDLE_MANIFEST,
  MAX_BUNDLE_BYTES,
  MAX_BUNDLE_ENTRIES,
  isBundlePath,
  validateBundleManifest,
} from './bundle/format.js';
export type { BundleManifest, BundleMount } from './bundle/format.js';
export { packBundle } from './bundle/pack.js';
export type { BundlePlan, PackedBundle } from './bundle/pack.js';
export { extractBundle } from './bundle/unpack.js';

export {
  BundleError,
  CompileError,
  LLMError,
  messageOf,
  PluginError,
  RunError,
  SandboxError,
  SessionConflictError,
  SessionError,
  SpecError,
  ToolError,
  WorkspaceError,
} from './errors.js';
