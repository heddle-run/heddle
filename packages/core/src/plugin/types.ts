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
import type { Message } from '../llm/types.js';
import type { Dependencies } from '../node/types.js';
import type { LogLevel } from '../runner/events.js';

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

/**
 * The half of a plugin's context that reports on work in progress.
 *
 * Shared by nodes and transforms, and shared deliberately. Both are silent for
 * the whole of their execution — a plugin node emits nothing between
 * `node_start` and `node_complete`, and a transform emits nothing ever — and
 * neither silence is more defensible than the other. A guardrail that rejects a
 * prompt has as much to say about why as a judge node has about its progress,
 * and an author who learns one API should not find the other missing it.
 */
export interface PluginReporter {
  /**
   * Report something structured to whoever is watching the run.
   *
   * `name` is the plugin's half of the event type and heddle supplies the rest,
   * publishing the event as `plugin:<componentType>:<name>`. A plugin never
   * chooses the whole type, which is what stops it emitting `flow_complete` and
   * telling every client watching the run that a flow it does not own has
   * finished. `name` has to be an identifier — see `pluginEventType` — and one
   * that is not throws here rather than reaching a client.
   *
   * `data` reaches the client verbatim, so it has to survive `JSON.stringify`.
   * A payload that does not is refused here for the reason given on
   * `assertSerializable`.
   */
  emitEvent(name: string, data?: unknown): void;
  /**
   * Say something for a person watching the run.
   *
   * **Not a duplicate of stderr**, which a plugin also has. Out of process,
   * stderr is capped at 4 KB and read only when the process *fails*
   * (`PluginHost`), so a plugin that works has no way to say anything at all;
   * in process it lands in heddle's own stderr, ordered against nothing and
   * seen by nobody watching the run. A log line here is an event: it survives
   * success, it arrives in order with `emitEvent` and with the engine's own
   * events, and it goes to the run's stream — where the client is already
   * looking — instead of an operator's terminal.
   *
   * **Not a duplicate of `emitEvent` either**, and the difference is who the
   * payload is for. `data` is the plugin's own shape, so only a client written
   * against that plugin can render it. A log line is heddle's shape — a level
   * and a string — so every client can render it without knowing the plugin
   * exists. That is why this cannot carry `data`: the moment it could, it would
   * be `emitEvent` under a worse name.
   */
  log(level: LogLevel, message: string): void;
}

/** Runtime services handed to a plugin node on every execution. */
export interface PluginContext extends PluginReporter {
  signal: AbortSignal | undefined;
  /** The node instance being executed, with its spec fields. */
  node: PluginNode;
  /** Run one of the flow's registered tools by name. */
  runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /**
   * A directory this execution may write to, shared with the tools it runs.
   *
   * **The sharing is the point, not the scratch.** A plugin can always make its
   * own temp directory; what it cannot do is find the one its tools can see.
   * Under `--safe` a node's tool calls are confined to a session workspace and
   * nothing else on the filesystem exists for them, so a plugin that ran
   * `mkdtemp` and passed the path to {@link PluginContext.runTool} would hand
   * the tool a path that is not there on its side — a failure that appears only
   * under sandboxing, only at the tool, and reads as the tool being broken.
   * heddle knows which directory that is; the plugin has no way to. This is it,
   * and a file written here can be named to `runTool` by path.
   *
   * It is also the only channel for anything large. `runTool` input is JSON on
   * its way to a subprocess's stdin, so a plugin with a 200 MB artifact to hand
   * over has one option, and it is this one.
   *
   * **Scoped to this execution.** heddle creates the directory and destroys it
   * when the node returns, so a plugin that fails partway leaves nothing behind
   * and a run cannot accumulate scratch. Nothing written here reaches the next
   * node — what a node passes on goes in its `output`.
   *
   * The same string on every call, and cheap to call: with a sandbox it is the
   * session's own workspace, and without one heddle makes a directory the first
   * time a plugin asks and not before.
   *
   * **Not a confinement.** In process, a plugin is the same program as heddle
   * and can open any path it likes; this says where it *should* write, not
   * where it *can*.
   */
  getWorkspace(): string;
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
  action: TransformAction;
  /** Replacement messages for `modify`, or the refusal to return for `reject`. */
  messages?: Message[];
  reason?: string;
}

export type TransformAction = 'pass' | 'modify' | 'reject';

/**
 * The closed set, as data.
 *
 * Both paths that take a transform's answer have to check it — an in-process
 * plugin returns a JS object of its own making, a remote one returns parsed
 * JSON — and a type checks neither. Keyed by the action type so an action added
 * to {@link TransformAction} and forgotten here is a compile error, rather than
 * one the checks quietly refuse.
 */
const ACTIONS: Record<TransformAction, true> = {
  pass: true,
  modify: true,
  reject: true,
};

export const TRANSFORM_ACTIONS = Object.keys(ACTIONS) as TransformAction[];

/**
 * The set as an error message names it: "pass, modify or reject".
 *
 * Derived rather than written out, because both places that reject an action
 * have to list what they would have accepted, and a list transcribed twice is a
 * list that stops being true the day a fourth action exists.
 */
export const TRANSFORM_ACTIONS_PROSE = `${TRANSFORM_ACTIONS.slice(0, -1).join(
  ', ',
)} or ${TRANSFORM_ACTIONS.at(-1)}`;

export function isTransformAction(value: unknown): value is TransformAction {
  return typeof value === 'string' && Object.hasOwn(ACTIONS, value);
}

/**
 * What a transform is handed on every application.
 *
 * The reporting half is {@link PluginReporter}, the same one a node gets. What
 * a transform does *not* get is {@link PluginContext.getWorkspace}, and that is
 * a property of where it runs rather than a judgement about transforms: a node
 * opens a tool scope of its own, so the tools it runs share one workspace and a
 * path into it means something. A transform runs inside an agent's turn and
 * owns no scope, so its tool calls each get a throwaway sandbox session that is
 * destroyed when the call returns. There is no directory here that two calls
 * would agree on, and handing over one that only the transform can see would be
 * a `mkdtemp` with heddle's name on it.
 */
export interface TransformContext extends PluginReporter {
  signal: AbortSignal | undefined;
  phase: TransformPhase;
  component: PluginComponent;
}

/** The runtime half of a custom transform. */
export interface PluginTransformExecutor {
  apply(
    messages: Message[],
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
