/**
 * The engine without the machine.
 *
 * This entry is `@heddle-run/core` for hosts that cannot start a process or
 * open a file: everything here is pure computation over what the host hands
 * in — flow text, plugin sources, input values — plus `fetch` for the model.
 * It is what the iOS app evaluates inside JavaScriptCore, and what any other
 * embedder without an exec would.
 *
 * What is deliberately absent, and why:
 *  - `SubprocessExecutor`, `PluginHost`, `loadPlugins`, the sandbox — each
 *    spawns. A portable host's plugins run in-process through `servePlugin`,
 *    and its tools are the plugin-provided kind.
 *  - `loadFlow`, `FileSessionStore`, `packBundle`/`extractBundle`, the
 *    preflight *check* half — each reads a disk. The host reads; this parses.
 *  - Workspaces and mounts — they exist to give subprocesses a directory.
 *
 * The build gate is the definition of done: `scripts/build-portable.mjs`
 * bundles this entry for a neutral platform, so a `node:*` import reaching
 * this graph fails the build rather than the app. What the host must provide
 * before evaluating the bundle is written down in `PORTABLE.md`.
 */

// The spec, as text the host read from wherever it keeps bundles.
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

// The engine proper.
export { compile } from './graph/compile.js';
export { validate } from './graph/validate.js';
export { CompiledGraph } from './graph/types.js';
export type { CompiledNode, DataSource } from './graph/types.js';
export { Runner } from './runner/runner.js';
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
export type { Dependencies, NodeExecutor } from './node/types.js';

// Sessions: the semantics travel, the storage stays with the host. A
// portable host implements the 7-method `SessionStore` over whatever blob
// storage it has.
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

// Plugins, in-process. `servePlugin` is the portable half of what
// `loadPlugins` does on a machine with processes: the host evaluates a
// manifest plugin's entry source in its own context and gets the same
// `HeddlePlugin` a subprocess would have answered for.
export { definePlugin } from './plugin/types.js';
export { PluginRegistry, SUBMITTABLE_KINDS } from './plugin/registry.js';
export type { ComponentKind, RegisteredMiddleware } from './plugin/registry.js';
export { servePlugin } from './plugin/serve-local.js';
export type { LocalPluginServices } from './plugin/serve-local.js';
export {
  evaluateLinked,
  linkEntry,
  usesModuleSyntax,
} from './plugin/esm-link.js';
export type { LinkedModule, LinkResult } from './plugin/esm-link.js';
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
export {
  isLogLevel,
  isPluginMethod,
  LOG_LEVELS,
  PLUGIN_METHODS,
  PROTOCOL_VERSION,
} from './plugin/protocol.js';
export type { PluginMethod } from './plugin/protocol.js';
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
} from './plugin/types.js';

// The event contract, rendered. One frame shape for every transport — the
// CLI's stdout, the server's SSE, and a JavaScriptCore host's callback all
// carry what `builtinEncoder` yields.
export {
  builtinEncoder,
  BUILTIN_PROTOCOL,
  encoderFor,
  EncoderStream,
  PROTOCOL_NAME,
  serializeEvent,
} from './plugin/encoder.js';
export type { ResolvedEncoder } from './plugin/encoder.js';

// Tools: only the invocation seam. A portable host has no tool directory —
// its tools are `{kind:'plugin'}` handlers a plugin declared, and those are
// dispatched without an executor.
export { invokeTool } from './tool/invoke.js';
export type {
  Executor,
  ExecResult,
  ExecutorScope,
  Registry,
  ToolDef,
  ToolHandler,
  ToolImpl,
} from './tool/types.js';

// The model, over the host's fetch.
export {
  createProvider,
  generationParams,
  isBuiltinConfigType,
  providerFor,
} from './llm/provider.js';
export type { ProviderOptions } from './llm/provider.js';
export {
  ENV_REF_PREFIX,
  collectEnvRefs,
  envRefKey,
  isEnvRef,
} from './llm/env-refs.js';
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

// The bundle format as data: what a manifest says, whether it could run
// here, and how a library name becomes an address. The archive itself is the
// host's problem — extraction happens natively, before this code runs.
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
export { checkPortability } from './bundle/portable.js';
export type {
  PortabilityReport,
  PortablePluginInput,
} from './bundle/portable.js';
export {
  isLibraryName,
  isRemotePath,
  LIBRARY,
  libraryUrl,
} from './bundle/library.js';

// Requirements: the parse half only. A portable host can read what a bundle
// asks for and render the report; it checks `env` ones against its own key
// store and treats the rest as portability blockers.
export {
  envRequirements,
  formatRequirements,
  parseRequirements,
  requirementLabel,
} from './preflight/parse.js';
export type {
  BinaryRequirement,
  CheckedRequirement,
  EnvRequirement,
  FileRequirement,
  NodeRequirement,
  Requirement,
  Unmet,
} from './preflight/parse.js';

export {
  BundleError,
  CompileError,
  LLMError,
  messageOf,
  PluginError,
  RequirementError,
  RunError,
  SandboxError,
  SessionConflictError,
  SessionError,
  SpecError,
  ToolError,
  WorkspaceError,
} from './errors.js';
