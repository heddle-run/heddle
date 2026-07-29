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
import type { ChatResponse, Message, ModelRequest } from '../llm/types.js';
import type { Dependencies } from '../node/types.js';
import type { LogLevel } from '../runner/events.js';
import type { AfterVerdict } from './protocol.js';
import type { Seam, SeamSubscription } from './seams.js';

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

/**
 * Everything a plugin may ask heddle to do while it runs.
 *
 * Shared by nodes and transforms for the reason {@link PluginReporter} is: what
 * a component may do has to follow from the component, not from where in the
 * spec it was written. A guardrail that consults a classifier tool, or asks a
 * model whether a prompt is an injection attempt, is the ordinary case for a
 * transform — and for a while it was a case that worked out of process and not
 * in it, which is not a capability model but an accident.
 *
 * Every method here is a {@link import('./protocol.js').PluginCapability}, so a
 * plugin gets each one only by declaring it and only where the host allows it.
 * {@link PluginContext.getWorkspace} is the exception that proves the shape: it
 * is not a call into heddle, so it is not here.
 */
export interface PluginServices extends PluginReporter {
  signal: AbortSignal | undefined;
  /**
   * Run one of the flow's registered tools by name.
   *
   * A node's tools run in the scope heddle opened for its execution, so they
   * share the directory {@link PluginContext.getWorkspace} names and can be
   * handed a file by path. A transform owns no scope, so each of its tool calls
   * gets a throwaway sandbox session and shares a workspace with nothing —
   * which is why a transform has no `getWorkspace` to offer.
   */
  runTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  /**
   * Ask the model one question, and get the whole answer back.
   *
   * **The plugin composes the request; the spec chooses the model.** The call
   * goes to the `llm_config` on this component — the same field an agent
   * carries — so a plugin ships no SDK, holds no credential, and cannot send a
   * request anywhere the submitted document does not say it will go. A
   * component with no `llm_config` gets an error naming the field, never a
   * silent fallback to whatever endpoint the operator configured.
   *
   * Buffered. There is no streamed form and there will not be one at this
   * level: heddle cannot tell a plugin's model call from its scratch work — a
   * judge asks for `{"score":…}` and returns a number — so publishing the
   * tokens would put a plugin's private reasoning into the same `token_delta`
   * a client renders as the run's answer. Report progress with
   * {@link PluginReporter.emitEvent}, which is namespaced and cannot be
   * mistaken for one of heddle's own events.
   */
  callModel(request: ModelRequest): Promise<ChatResponse>;
}

/** Runtime services handed to a plugin node on every execution. */
export interface PluginContext extends PluginServices {
  /** The node instance being executed, with its spec fields. */
  node: PluginNode;
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
  action: 'pass' | 'modify' | 'reject';
  /** Replacement messages for `modify`, or the refusal to return for `reject`. */
  messages?: Message[];
  reason?: string;
}

/**
 * What a transform is handed on every application.
 *
 * The same {@link PluginServices} a node gets, and the one thing missing from
 * it is {@link PluginContext.getWorkspace} — a property of where a transform
 * runs rather than a judgement about transforms. A node opens a tool scope of
 * its own, so the tools it runs share one workspace and a path into it means
 * something. A transform runs inside an agent's turn and owns no scope, so its
 * tool calls each get a throwaway sandbox session that is destroyed when the
 * call returns. There is no directory here that two calls would agree on, and
 * handing over one that only the transform can see would be a `mkdtemp` with
 * heddle's name on it.
 */
export interface TransformContext extends PluginServices {
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

/**
 * What a middleware is handed when a seam consults it.
 *
 * The reporting half is {@link PluginReporter}, as every other kind gets, and
 * `runTool`/`callModel` are here for the same reason they are on a transform: a
 * retry policy that consults a health endpoint, or a fallback that asks a model
 * for a canned apology, is the ordinary case rather than the exotic one.
 *
 * What is absent is the node's state. A middleware is installed by the operator
 * and named nowhere in the caller's document, so handing it the run's data
 * would disclose one caller's information to code they never asked for — see
 * `AfterParams`. `subject` names which node failed and `outcome` says how; a
 * component that needs the data itself is a plugin node, which the flow names.
 */
export interface MiddlewareContext extends PluginServices {
  /** Which seam is asking, so one handler table can serve several. */
  seam: Seam;
  /**
   * The operator's configuration for this component type.
   *
   * `{}` when the operator supplied none, never undefined — a middleware is
   * host-configured, so this is the only channel its settings can arrive on and
   * a handler should not have to guard the object before reading a field.
   */
  component: Record<string, unknown>;
  /** Which attempt this is, and the ceiling heddle will enforce. Both 1-based. */
  attempt: number;
  maxAttempts: number;
}

/** What a seam's call site produced, as a middleware sees it. */
export type SeamOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

/** What the call site was working on. For the node position, which node ran. */
export interface MiddlewareSubject {
  nodeName?: string;
  nodeType?: string;
}

/** The runtime half of a middleware: one `after` handler serving every seam it declared. */
export interface PluginMiddlewareExecutor {
  after(
    input: { subject: MiddlewareSubject; outcome: SeamOutcome },
    ctx: MiddlewareContext,
  ): AfterVerdict | Promise<AfterVerdict>;
}

/**
 * A middleware: a component that intercepts a call site rather than occupying a
 * slot in the spec.
 *
 * **Host-configured, never spec-named.** The operator loads it and a flow does
 * not mention it, which is the honest arrangement for something that runs on
 * every node whether the flow asked or not — and it keeps `loader.ts`'s rule
 * that sharing a spec can never cause code to run. A middleware a flow *does*
 * select is a transform, which already exists.
 *
 * There is therefore no `validate` worth having: `PluginComponentDef.validate`
 * checks a component out of a document, and there is no document here. What
 * takes its place is the manifest's `schema`, checked against the operator's
 * configuration when the plugin loads.
 */
export interface PluginMiddlewareDef {
  componentType: string;
  /** Which seams this subscribes to, and which halves of each. */
  seams: SeamSubscription;
  /**
   * Check the operator's configuration before anything is built from it.
   *
   * Throw to refuse it. This is where a manifest's `schema` is applied for an
   * out-of-process middleware, and where an in-process one may bring its own
   * validator — the same trade `PluginComponentDef.validate` offers, moved to
   * the only input a middleware has.
   *
   * Called even when the operator supplied nothing, because that is the case
   * that matters: a middleware declaring `maxAttempts` as required and
   * receiving `{}` is exactly the one that would otherwise read `undefined` on
   * the first node that failed.
   */
  validateConfig?(config: Record<string, unknown>): void;
  createMiddleware(
    config: Record<string, unknown>,
    deps: Dependencies,
  ): PluginMiddlewareExecutor;
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
  /**
   * Middleware, which unlike the other three is not registered by component
   * type for lookup — nothing looks a middleware up, because no document names
   * one. The registry keeps them in load order and hands the whole list over.
   */
  middleware?: PluginMiddlewareDef[];
}

/** Identity helper that gives plugin authors type checking and completion. */
export function definePlugin(plugin: HeddlePlugin): HeddlePlugin {
  return plugin;
}
