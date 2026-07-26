/**
 * Public plugin API.
 *
 * A plugin contributes custom Agent Spec component types to heddle. Agent Spec's
 * own plugin system covers serialization only — it teaches the deserializer how to
 * read a custom `component_type`, but says nothing about how to run it. These types
 * cover both halves: a declaration that heddle turns into an Agent Spec
 * deserialization plugin, plus the runtime executor that makes the node do something.
 */
import type { Property } from 'agentspec';
import type { Dependencies } from '../node/types.js';

/**
 * A lightweight input/output declaration. heddle converts these into Agent Spec
 * `Property` objects, so data flow edges into and out of plugin nodes type-check
 * the same way they do for builtin nodes.
 */
export interface PluginIO {
  title: string;
  type: string;
  description?: string;
  default?: unknown;
}

/**
 * A deserialized custom component. Field names arrive camelCased, matching how the
 * agentspec SDK presents builtin components.
 */
export interface PluginComponent {
  componentType: string;
  name: string;
  id: string;
  description?: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

/** A deserialized custom node — a component that can sit in a flow's graph. */
export interface PluginNode extends PluginComponent {
  inputs?: Property[];
  outputs?: Property[];
  branches?: string[];
}

/** What a plugin node executor hands back after running. */
export interface PluginResult {
  /** Becomes the node's output state. */
  output: Record<string, unknown>;
  /** Branch to follow, matching one of the node's declared `branches`. */
  branch?: string;
}

/** Runtime services handed to a plugin node on every execution. */
export interface PluginContext {
  signal: AbortSignal | undefined;
  /** The node instance being executed, with its spec fields. */
  node: PluginNode;
  /** Run one of the flow's registered tools by name. */
  runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/** The runtime half of a custom node. */
export interface PluginNodeExecutor {
  execute(
    input: Record<string, unknown>,
    ctx: PluginContext,
  ): Promise<PluginResult> | PluginResult;
}

/** A custom component type that is not itself a node (e.g. a `Processor`). */
export interface PluginComponentDef {
  /** The `component_type` string as it appears in the spec file. */
  componentType: string;
  /**
   * Optional check on the deserialized fields. Throw to reject the spec.
   * Bring your own validator — zod, a hand-written check, whatever.
   */
  validate?(component: PluginComponent): void;
}

/** A message in the conversation handed to a transform. */
export interface TransformMessage {
  role: string;
  content: string;
}

/**
 * Where in an agent's turn a transform runs: `pre` sees the messages on their
 * way to the model, `post` sees the model's answer on its way back.
 */
export type TransformPhase = 'pre' | 'post';

/**
 * What a transform hands back.
 *
 * `reject` is what makes a transform usable as a guardrail. In the `pre` phase
 * heddle skips the model call entirely, so a blocked prompt costs nothing.
 */
export interface TransformResult {
  action: 'pass' | 'modify' | 'reject';
  /** Replacement messages for `modify`, or the refusal to return for `reject`. */
  messages?: TransformMessage[];
  reason?: string;
}

export interface TransformContext {
  signal: AbortSignal | undefined;
  phase: TransformPhase;
  component: PluginComponent;
}

/** The runtime half of a custom transform. */
export interface PluginTransformExecutor {
  apply(
    messages: TransformMessage[],
    ctx: TransformContext,
  ): TransformResult | Promise<TransformResult>;
}

/**
 * A custom transform type: a component that hangs off `Agent.transforms` and
 * processes the agent's messages before or after the model call.
 */
export interface PluginTransformDef extends PluginComponentDef {
  /** Which phase(s) of the turn this runs in. Defaults to `pre`. */
  phase?(component: PluginComponent): TransformPhase | 'both';
  createTransform(
    component: PluginComponent,
    deps: Dependencies,
  ): PluginTransformExecutor;
}

/** A custom node type: a component plus the executor that runs it. */
export interface PluginNodeDef extends PluginComponentDef {
  /** Inputs to advertise when the spec file does not declare them. */
  inferInputs?(node: PluginNode): PluginIO[];
  /** Outputs to advertise when the spec file does not declare them. */
  inferOutputs?(node: PluginNode): PluginIO[];
  /**
   * Branch names this node can take. Must be static: heddle's graph validator
   * checks reachability before anything executes.
   */
  branches?(node: PluginNode): string[];
  createExecutor(node: PluginNode, deps: Dependencies): PluginNodeExecutor;
}

/** A heddle plugin. Default-export one of these from a plugin module. */
export interface HeddlePlugin {
  /** Written to `component_plugin_name` when a spec is serialized. */
  name: string;
  /** Written to `component_plugin_version` when a spec is serialized. */
  version: string;
  components?: PluginComponentDef[];
  nodes?: PluginNodeDef[];
  transforms?: PluginTransformDef[];
}

/** Identity helper that gives plugin authors type checking and completion. */
export function definePlugin(plugin: HeddlePlugin): HeddlePlugin {
  return plugin;
}
