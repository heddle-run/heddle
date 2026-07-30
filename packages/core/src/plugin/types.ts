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
import type { AfterVerdict } from './protocol.js';
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
}

export type SeamOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

export interface MiddlewareSubject {
  nodeName?: string;
  nodeType?: string;
}

export interface PluginMiddlewareExecutor {
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

export interface HeddlePlugin {
  name: string;
  version: string;
  components?: PluginComponentDef[];
  nodes?: PluginNodeDef[];
  transforms?: PluginTransformDef[];
  providers?: PluginProviderDef[];
  encoders?: PluginEncoderDef[];
  middleware?: PluginMiddlewareDef[];
  tools?: ToolDef[];
}

export function definePlugin(plugin: HeddlePlugin): HeddlePlugin {
  return plugin;
}
