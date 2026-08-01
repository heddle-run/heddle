import type { Property } from 'agentspec';
import type {
  ChatResponse,
  Message,
  ModelRequest,
  Provider,
} from '../llm/types.js';
import type { Dependencies } from '../node/types.js';
import type { ToolDef } from '../tool/types.js';
import type { Event, LogLevel } from '../runner/events.js';
import type { SessionStore } from '../session/store.js';
import type { AfterVerdict, BeforeVerdict } from './protocol.js';
import type { Seam, SeamSubscription } from './seams.js';

export interface PluginIO {
  title: string;
  type: string;
  description?: string;
  default?: unknown;
}

export interface PluginComponent {
  componentType: string;
  name: string;
  id: string;
  description?: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PluginNode extends PluginComponent {
  inputs?: Property[];
  outputs?: Property[];
  branches?: string[];
}

export interface PluginResult {
  output: Record<string, unknown>;
  branch?: string;
}

export interface PluginReporter {
  emitEvent(name: string, data?: unknown): void;
  log(level: LogLevel, message: string): void;
}

export interface PluginServices extends PluginReporter {
  signal: AbortSignal | undefined;
  runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  callModel(request: ModelRequest): Promise<ChatResponse>;
}

export interface PluginContext extends PluginServices {
  node: PluginNode;
  getWorkspace(): string;
}

export interface PluginNodeExecutor {
  execute(
    input: Record<string, unknown>,
    ctx: PluginContext,
  ): Promise<PluginResult> | PluginResult;
}

export interface PluginComponentDef {
  componentType: string;
  validate?(component: PluginComponent): void;
}

export type TransformPhase = 'pre' | 'post';

export interface TransformResult {
  action: 'pass' | 'modify' | 'reject';
  messages?: Message[];
  reason?: string;
}

export interface TransformContext extends PluginServices {
  phase: TransformPhase;
  component: PluginComponent;
}

export interface PluginTransformExecutor {
  apply(
    messages: Message[],
    ctx: TransformContext,
  ): TransformResult | Promise<TransformResult>;
}

export interface PluginTransformDef extends PluginComponentDef {
  phase?(component: PluginComponent): TransformPhase | 'both';
  createTransform(
    component: PluginComponent,
    deps: Dependencies,
  ): PluginTransformExecutor;
}

export interface PluginNodeDef extends PluginComponentDef {
  inferInputs?(node: PluginNode): PluginIO[];
  inferOutputs?(node: PluginNode): PluginIO[];
  branches?(node: PluginNode): string[];
  createExecutor(node: PluginNode, deps: Dependencies): PluginNodeExecutor;
}

export interface MiddlewareContext extends PluginServices {
  seam: Seam;
  component: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  /**
   * The answer a human gave, when this consultation is a resumed suspension.
   *
   * Only ever set on `node.before`, and it closes a hole that seam would
   * otherwise have. A `toolCall` suspension is never re-consulted — the agent's
   * bookmark replays the answer as the call's result, so the gate is not asked
   * again. A `node` suspension *is*: resuming re-enters the node, and every
   * `before` hook is consulted afresh. A gate with no way to tell "I am being
   * asked again, and here is what they said" from "I am being asked for the
   * first time" would suspend forever.
   */
  answered?: Record<string, unknown>;
}

export type SeamOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

export interface MiddlewareSubject {
  nodeName?: string;
  nodeType?: string;
  /** For `toolCall`: which tool, and which of the model's calls asked for it. */
  toolName?: string;
  toolCallId?: string;
}

export interface PluginMiddlewareExecutor {
  /**
   * Consulted before a call site acts, on the seams that have a `before` half.
   *
   * Optional, because a middleware subscribes per half: one that declared only
   * `after` is never asked, and one that declared `before` and serves no handler
   * is refused when the chain is built rather than discovered mid-run.
   */
  before?(
    input: { subject: MiddlewareSubject; input: Record<string, unknown> },
    ctx: MiddlewareContext,
  ): BeforeVerdict | Promise<BeforeVerdict>;
  after(
    input: { subject: MiddlewareSubject; outcome: SeamOutcome },
    ctx: MiddlewareContext,
  ): AfterVerdict | Promise<AfterVerdict>;
}

export interface PluginProviderDef extends PluginComponentDef {
  createProvider(config: PluginComponent, deps: Dependencies): Provider;
}

export interface WireFrame {
  event?: string;
  data: unknown;
}

export interface PluginEncoder {
  encode(event: Event): Promise<WireFrame[]> | WireFrame[];
  finish(): Promise<WireFrame[]> | WireFrame[];
}

export interface PluginEncoderDef extends PluginComponentDef {
  protocol: string;
  contentType: string;
  createEncoder(runId: string): PluginEncoder;
}

export interface PluginMiddlewareDef {
  componentType: string;
  seams: SeamSubscription;
  validateConfig?(config: Record<string, unknown>): void;
  createMiddleware(
    config: Record<string, unknown>,
    deps: Dependencies,
  ): PluginMiddlewareExecutor;
}

/**
 * Where a deployment keeps its conversations.
 *
 * Installed by the operator and never named by a spec, like a middleware and an
 * encoder — a flow does not get to choose where its transcript goes. Unlike
 * both, exactly one is ever *in use*: a store is selected by name at startup,
 * and a process has one place it writes.
 *
 * Built once, at startup, rather than per run. It is the one plugin component
 * whose whole value is outliving a run — a connection pool that were rebuilt
 * per request would cost more than the file store it replaced.
 */
export interface PluginStoreDef extends PluginComponentDef {
  createStore(config: Record<string, unknown>): SessionStore;
}

export interface HeddlePlugin {
  name: string;
  version: string;
  components?: PluginComponentDef[];
  nodes?: PluginNodeDef[];
  transforms?: PluginTransformDef[];
  providers?: PluginProviderDef[];
  encoders?: PluginEncoderDef[];
  middleware?: PluginMiddlewareDef[];
  stores?: PluginStoreDef[];
  tools?: ToolDef[];
  /**
   * Files this plugin puts in the workspace of every node that runs.
   *
   * Not a seventh kind — nothing chooses these, and there is no verb behind
   * them. They are the second thing a plugin *ships*, beside its tools, and
   * heddle copies them without starting anything.
   *
   * Absolute host paths. An out-of-process plugin's are resolved inside its own
   * directory by the rule `ManifestTool.path` follows; an in-process plugin
   * supplies its own, unchecked, because it is already running with the
   * privileges of whatever imported it and a check there would be theatre.
   *
   * Always read-only in the workspace. A plugin ships files; it does not get a
   * writable channel onto the operator's disk.
   */
  files?: WorkspaceFile[];
}

export interface WorkspaceFile {
  /** An absolute host path: a file or a directory. */
  path: string;
  /** Where it lands in the workspace, relative to the root. */
  dest: string;
}

export function definePlugin(plugin: HeddlePlugin): HeddlePlugin {
  return plugin;
}
