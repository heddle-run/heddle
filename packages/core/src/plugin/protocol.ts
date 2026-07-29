/**
 * The wire protocol between heddle and an out-of-process plugin.
 *
 * JSON Lines over the plugin's stdin and stdout: one JSON object per line, no
 * length prefix, no framing beyond the newline. That choice is deliberate — a
 * plugin can be written in any language with a JSON parser and a read loop,
 * which is the same bar a tool already has to clear.
 *
 * The channel is bidirectional, because a plugin needs to call back into
 * heddle: `ctx.runTool` is the whole reason a plugin is more than a filter. So
 * both sides send requests and both answer them, on the same pair of pipes.
 *
 * Direction is decided by shape, not by a field:
 *
 *   request   { id, method, params }
 *   response  { id, result }  |  { id, error: { name, message } }
 *   partial   { id, partial }
 *
 * A response always carries the id of the request it answers, and each side
 * only tracks ids it issued itself, so the two id spaces never have to agree.
 *
 * stderr is not part of the protocol. It is left to the plugin for logging and
 * is surfaced verbatim when the process fails, which is where a plugin author
 * will look first.
 */
import { PluginError } from '../errors.js';
import type { Message, ModelRequest, Role, ToolDefinition } from '../llm/types.js';
import type { LogLevel } from '../runner/events.js';
import { SEAMS, type AfterAction, type Seam } from './seams.js';

/**
 * The protocol's version, as an integer rather than a semver string.
 *
 * Semver's whole value is that it expresses a *range* — a consumer asks for
 * `^1.2` and a producer's `1.3` satisfies it. That trade needs one side able to
 * enumerate what it requires of the other, and neither side here can: a plugin
 * cannot know that this heddle routes `{ id, partial }` frames, and heddle
 * cannot know which of a plugin's replies depend on a frame it has no rule for.
 * With no range to express, a semver string would only invite a compatibility
 * policy nobody can evaluate at the handshake.
 *
 * **Compatible means equal.** Any difference in either direction fails the
 * call, naming both versions. Raising this number is therefore a deliberate
 * break of every plugin already written, which is why the partial frame and the
 * lifecycle verbs all land inside version 1 rather than one per release.
 */
export const PROTOCOL_VERSION = 1;

/**
 * What a plugin that says nothing about its version is taken to speak.
 *
 * Version 1 *is* the protocol as it stood before `init` existed, so a plugin
 * that has never heard of the handshake — one that answers "unknown method", or
 * answers with a result carrying no `protocol` — is by construction speaking it.
 * Reading that silence as 1 rather than as a failure is what keeps every plugin
 * written before the handshake working; refusing it would be exactly the
 * compatibility break the handshake exists to prevent.
 *
 * The day {@link PROTOCOL_VERSION} moves past 1, the same silence stops being
 * compatible and is reported as the mismatch it now is. That is the point.
 */
const UNVERSIONED = 1;

/** The version an `init` result claims, or {@link UNVERSIONED} if it claims none. */
export function spokenProtocol(result: unknown): number {
  if (typeof result === 'object' && result !== null) {
    const { protocol } = result as { protocol?: unknown };
    if (typeof protocol === 'number' && Number.isInteger(protocol)) return protocol;
  }
  return UNVERSIONED;
}

/**
 * Methods heddle calls on a plugin to do a component's work, each mapped to the
 * params it carries.
 *
 * The map, rather than a bare union of names, is what {@link HostMethod} is
 * derived from — so a verb cannot be added without declaring its shape, and
 * `PluginHost.call` can check the params against the method at every call site.
 * With two verbs an unchecked string was survivable; the roadmap has eight, and
 * at that width a typo reaches the wire and comes back as the plugin's own
 * "unknown method" from another process.
 */
export interface HostMethods {
  /** Run one custom node. */
  execute: ExecuteParams;
  /** Run one message transform. */
  apply: ApplyParams;
  /** Consult one middleware after a seam's call site produced its outcome. */
  after: AfterParams;
}

export type HostMethod = keyof HostMethods;

/**
 * Methods the host sends on its own behalf, kept out of {@link HostMethods}.
 *
 * These are not work anyone asked for: `PluginHost` decides when a plugin is
 * greeted, cancelled and stopped, and each one is paired with machinery — a
 * version check, a grace timer, a SIGKILL — that a caller reaching them through
 * `call()` would bypass while appearing to have used them. Splitting the map is
 * what makes that impossible rather than merely discouraged, while still
 * refusing to let a lifecycle verb reach the wire without its shape written
 * down here.
 */
export interface HostLifecycleMethods {
  /** Exchange protocol versions and tell the plugin what it was granted. */
  init: InitParams;
  /** Ask the plugin to stop, before the process is killed. */
  shutdown: ShutdownParams;
  /** Ask the plugin to drop one in-flight call. */
  cancel: CancelParams;
}

/** Every verb heddle can put on the wire, work and lifecycle alike. */
export interface HostVerbs extends HostMethods, HostLifecycleMethods {}

export type HostVerb = keyof HostVerbs;

/**
 * Build one of heddle's own requests, with its params checked against its verb.
 *
 * {@link RpcRequest} cannot supply that check: its `method` is a bare string,
 * because the same shape carries the plugin's requests travelling the other
 * way. `PluginHost.call` gets the check from its own generic signature instead,
 * which leaves the lifecycle verbs — the ones the host sends on its own behalf,
 * with no caller and no `HostMethods` entry — as the only frames that reached
 * the wire unchecked. Building them here is what makes {@link HostVerbs} a rule
 * rather than a list: a mistyped verb, or the wrong params for a real one, is a
 * compile error here instead of the plugin's own "unknown method" arriving a
 * round trip later, naming the plugin for heddle's typo.
 */
export function hostRequest<V extends HostVerb>(
  id: number,
  method: V,
  params: HostVerbs[V],
): RpcRequest {
  return { id, method, params };
}

/** Methods a plugin calls on heddle, each mapped to the params it carries. */
export interface PluginMethods {
  /** Run one of the flow's registered tools. */
  runTool: RunToolParams;
  /** Publish one event on the run's stream, under the plugin's own namespace. */
  emitEvent: EmitEventParams;
  /** Say one thing, at a level, for whoever is watching the run. */
  log: LogParams;
  /** Ask the model this component's spec names for one answer. */
  callModel: CallModelParams;
}

export type PluginMethod = keyof PluginMethods;

/**
 * What a plugin may ask heddle to do, as a manifest names it.
 *
 * The same set as {@link PluginMethod}, by construction rather than by
 * coincidence. A reverse call is the only thing a plugin can do to heddle that
 * heddle would not otherwise have done, so every reverse call needs a gate and
 * a gate over anything else would guard nothing. Deriving the alias is what
 * stops the two lists drifting: a verb added to `PluginMethods` is grantable
 * the day it exists, and cannot be added without being gated.
 */
export type PluginCapability = PluginMethod;

/**
 * The reverse calls heddle serves, as data.
 *
 * A `Record` keyed by the method type, so adding a `PluginMethod` without
 * listing it here is a compile error rather than a call that silently comes
 * back "unknown method". The list is also what that error names, since a plugin
 * author who guessed wrong needs to be told what does exist.
 */
const SERVED: Record<PluginMethod, true> = {
  runTool: true,
  emitEvent: true,
  log: true,
  callModel: true,
};

export const PLUGIN_METHODS = Object.keys(SERVED) as PluginMethod[];

/** The closed set a manifest's `capabilities` is checked against. */
export const PLUGIN_CAPABILITIES: PluginCapability[] = PLUGIN_METHODS;

export function isPluginMethod(method: string): method is PluginMethod {
  return Object.hasOwn(SERVED, method);
}

export function isPluginCapability(value: string): value is PluginCapability {
  return isPluginMethod(value);
}

export interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { name?: string; message: string };
}

/**
 * Progress on a call that has not finished: `{ id, partial }`.
 *
 * A third frame shape, and the reason it exists before anything emits one. The
 * two rules that make it useful both live in the host's routing, not in the
 * data: a partial does not settle the call, and it *does* restart the call's
 * timeout, because a plugin streaming steadily for ten minutes is working and a
 * timer measuring only time-since-request cannot tell it from one that hung.
 *
 * Landing the shape now is the whole point. A host that does not know this
 * frame routes it to the response handler, where `{ id, partial }` has no
 * `error` and no `result` — so it resolves the call with `undefined` and the
 * caller gets a plugin that "returned nothing". Adding the shape after
 * third-party plugins exist is therefore a flag day; adding it now costs a
 * branch nobody takes yet.
 *
 * ---
 *
 * **This is not `emitEvent` in another envelope**, and the line between them is
 * where the payload goes.
 *
 * A partial is *a piece of one call's answer*. It is delivered to whatever
 * inside heddle is awaiting that call and to nothing else — `PluginHost.call`
 * hands it to the `onPartial` its own caller passed — so what it means is
 * decided by that call site, not by the plugin. Nothing in heddle passes an
 * `onPartial` for a plugin's `execute` or `apply` today, which is why the
 * inlined runtime offers a plugin author no way to send one: a frame whose only
 * consumer would be `undefined` is not a progress channel, and offering it as
 * one would be handing authors a choice whose wrong answer is silence.
 *
 * An {@link EmitEventParams} event is *a report about the run*. It is published
 * on the run's event stream, reaches every client watching it, is namespaced so
 * it cannot be mistaken for one of heddle's own, and outlives the call that
 * made it. It is also a {@link PluginCapability}, which a partial cannot be: a
 * partial is a frame, so there is no request to refuse and no response to be
 * refused on. That is the deciding argument for `emitEvent` being a verb rather
 * than a shape of partial — a malformed event name has to come back as an
 * error, and a frame with no id to answer can only be dropped.
 *
 * What the two share is the clock: both reset the timeout of the call they name
 * (see `PluginHost.call`), because a plugin saying anything at all is a plugin
 * that has not hung. An author never has to pick a frame in order to stay alive.
 */
export interface RpcPartial {
  id: number | string;
  partial: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcPartial;

/**
 * Both discriminators take `unknown`, because what they are handed is whatever
 * `JSON.parse` made of a line a plugin wrote.
 *
 * `JSON.parse('null')` is `null`, and a plugin under `--allow-request-code` is
 * a stranger's program. Reading a property off that throws, on the stdout
 * `data` handler's stack, where nothing catches it — neither the server nor the
 * CLI installs an `uncaughtException` handler — so one malformed line from one
 * plugin would end the process and every concurrent run in it. A frame that is
 * not an object is simply not any of the three shapes.
 */
export function isObject(message: unknown): message is Record<string, unknown> {
  return typeof message === 'object' && message !== null && !Array.isArray(message);
}

export function isRequest(message: unknown): message is RpcRequest {
  return isObject(message) && typeof message.method === 'string';
}

/**
 * Checked against the presence of `partial` rather than the absence of the
 * other fields, and with `method` excluded so the three shapes stay disjoint
 * however the host happens to order its tests.
 */
export function isPartial(message: unknown): message is RpcPartial {
  return (
    isObject(message) &&
    typeof message.method !== 'string' &&
    Object.hasOwn(message, 'partial')
  );
}

/** Params for `init`, the first frame heddle writes to a plugin's stdin. */
export interface InitParams extends Record<string, unknown> {
  /** {@link PROTOCOL_VERSION}, for the plugin to check against its own. */
  protocol: number;
  /**
   * The reverse calls this plugin may make — the manifest's request after the
   * operator's grant has been applied to it, which is the same set the host
   * enforces. Sent so a plugin can read its own limits instead of discovering
   * them by making a call and being refused mid-run.
   */
  capabilities: PluginCapability[];
  /**
   * For each seam this plugin subscribed to, the verdicts that seam admits.
   *
   * The same reason `capabilities` is sent, applied to the other axis. `retry`
   * is honoured at the node position and cannot be at `toolCall`, and a
   * middleware that wants to work at both should be able to read that and fall
   * back to `replace` — rather than write one verdict, be refused at one seam,
   * and take the run down with it under the fatal policy.
   *
   * Absent when the plugin subscribes to no seam, which is every plugin that
   * provides no middleware.
   */
  seams?: Record<string, AfterAction[]>;
}

/** What a plugin answers `init` with. Anything else is read as {@link UNVERSIONED}. */
export interface InitResult {
  protocol: number;
}

/**
 * Params for `shutdown`: none. The verb is the whole message — a plugin is
 * being asked to stop, and there is nothing about that worth parameterising.
 */
export type ShutdownParams = Record<string, never>;

/** Params for `cancel`: the id of the call heddle has stopped waiting for. */
export interface CancelParams extends Record<string, unknown> {
  call: number | string;
}

/** Params for `execute`: run one custom node. */
export interface ExecuteParams extends Record<string, unknown> {
  componentType: string;
  /** The node's spec fields, so a plugin can read its own configuration. */
  node: Record<string, unknown>;
  /** The node's input state. */
  input: Record<string, unknown>;
  /**
   * The directory this execution shares with the tools it runs — what
   * `PluginContext.getWorkspace` returns, sent rather than asked for.
   *
   * A reverse call would have been the obvious shape and is the wrong one. The
   * value is a constant for the whole call and heddle knows it before it
   * dispatches, so a verb would spend a round trip, a capability grant and an
   * entry in {@link PluginMethods} on a string it already had — and it would
   * make `getWorkspace` asynchronous out of process and synchronous in it, so
   * the same plugin logic could not be written once. Sending it keeps
   * {@link PluginCapability} free of anything that is not a verb.
   *
   * The price is that heddle creates the directory for every remote node
   * execution, including the ones that never open it; in process the same call
   * is deferred until a plugin asks. That is one `mkdtemp` and one `rm` beside
   * a process boundary and a round trip, and only when there is no sandbox —
   * with one, this is the session's own workspace and already exists.
   *
   * **Absent when the plugin's own process is confined**, which is why this is
   * optional. `packages/server/src/plugins.ts` gives every submitted plugin its
   * own `SandboxSession` under `--safe`, and that session's confinement is
   * fixed when the process is spawned — `wrap()` is called once per plugin,
   * before any node executes, while the node's tool scope is opened per
   * execution afterwards. There is therefore no moment at which the node's
   * workspace could be bound into the plugin's namespace, and sending the path
   * anyway would hand an untrusted process a host path from outside its own
   * confinement that every write to fails: ENOENT under bubblewrap, which binds
   * only its own workspace, and EPERM under seatbelt, whose write rules do not
   * cover it. Omitted, `getWorkspace` fails inside the plugin naming the
   * limitation — see `workspaceOf` in runtime-source.ts — which is the one
   * thing this field must never do, namely hand back a path that is not there.
   *
   * The consequence is worth stating plainly: under `--safe` a plugin node
   * cannot pass a file to a tool it runs, because the two are confined to
   * different sandboxes. That is a real capability gap, and naming it is better
   * than papering over it with a path that fails at the first write.
   */
  workspace?: string;
  /**
   * Why {@link ExecuteParams.workspace} is absent, when it is.
   *
   * A node whose plugin is confined and a transform both arrive at the runtime
   * with no `workspace`, and they are different problems for different people —
   * one is an operator's `--safe`, the other is where the component was
   * written. Without this marker `getWorkspace` would have to blame transforms
   * for both, sending a node author to change something that is already right.
   */
  workspaceUnavailable?: 'confined';
}

/** Params for `apply`: run one message transform. */
export interface ApplyParams extends Record<string, unknown> {
  componentType: string;
  component: Record<string, unknown>;
  phase: 'pre' | 'post';
  messages: unknown[];
}

/** What a seam's call site was working on, as the middleware sees it. */
export interface SeamSubject {
  /** For the `node` position: the graph node that ran. */
  nodeName?: string;
  nodeType?: string;
}

/**
 * Params for `after`: one middleware consulted on one seam's outcome.
 *
 * One verb for every seam rather than a verb per seam, because a middleware
 * chain is one thing: the entries are evaluated in one order, the first
 * non-neutral verdict wins, and a plugin that subscribes to two seams answers
 * both through the same handler table. A verb per seam would make that
 * ordering a property of which verb heddle happened to send.
 *
 * The failing node's **input does not cross this boundary**, and that is a
 * decision rather than an omission. A middleware is installed by the operator
 * and named nowhere in the caller's document, so sending it the node's state
 * would disclose one caller's run data to code they never asked for — and it
 * would do so on every failure, for a value no verdict needs: `retry` re-runs
 * the node from the state heddle still holds, and `replace` supplies an output
 * rather than deriving one. A middleware that genuinely needs the data is a
 * plugin node, which the flow names.
 */
export interface AfterParams extends Record<string, unknown> {
  /** Which seam this is, so one handler table can serve several. */
  seam: Seam;
  componentType: string;
  /**
   * The operator's configuration for this component type, validated against the
   * manifest's `schema` when the plugin loaded.
   *
   * Middleware is host-configured — a flow never names it — so unlike every
   * other kind there is no document to read fields from. This is that document's
   * replacement, and it is `{}` rather than absent when the operator supplied
   * none, so a handler reading `component.maxAttempts` gets `undefined` and not
   * a crash.
   */
  component: Record<string, unknown>;
  subject: SeamSubject;
  /**
   * What the call site produced. `ok: false` carries the error's name and
   * message and **never its stack**: a stack is full of host paths, and the
   * process on the other end of this pipe is, under `--allow-request-code`, a
   * stranger's program.
   */
  outcome: { ok: true; value: unknown } | { ok: false; error: { name: string; message: string } };
  /**
   * Which attempt this is, 1-based, and the ceiling heddle will enforce.
   *
   * Always present, and `1`/`1` on a seam that does not admit `retry`, so a
   * handler never has to test for the field. heddle counts, because a middleware
   * re-invoked with a fresh call has nothing durable to count with — a module
   * -scope counter in the plugin would see attempt 1 forever, or would leak
   * across the runs that share its process.
   */
  attempt: number;
  maxAttempts: number;
}

/**
 * What a middleware answers an `after` with.
 *
 * `pass` is the neutral verdict and the only one that lets the chain continue;
 * the first entry to answer anything else wins and the rest are not consulted.
 * That is the rule `TransformChain.apply` already runs under, and it is what
 * makes retry-versus-fail conflicts unreachable rather than ranked.
 */
export type AfterVerdict =
  | { action: 'pass' }
  | { action: 'replace'; value: Record<string, unknown> }
  | { action: 'retry'; delayMs?: number }
  | { action: 'fail'; reason: string };

/**
 * Read a verdict that arrived from a plugin's process.
 *
 * Checked against the seam rather than against the union, so a `retry` sent to
 * a seam whose call site cannot re-issue anything is refused here — naming what
 * that seam does admit — instead of being honoured somewhere it corrupts the
 * call it re-enters. The list comes from {@link SEAMS}, so the check and the
 * handshake that told the plugin its limits cannot disagree.
 */
export function readAfterVerdict(seam: Seam, raw: unknown, where: string): AfterVerdict {
  if (!isObject(raw)) {
    throw new PluginError(`${where}: returned ${typeName(raw)}, expected { action }`);
  }

  const admitted = SEAMS[seam].after;
  const { action } = raw;
  if (typeof action !== 'string' || !admitted.includes(action as AfterAction)) {
    throw new PluginError(
      `${where}: returned action ${JSON.stringify(action)}. The "${seam}" seam ` +
        `admits: ${admitted.join(', ')}.`,
    );
  }

  switch (action as AfterAction) {
    case 'pass':
      return { action: 'pass' };

    case 'replace': {
      if (!isObject(raw.value)) {
        throw new PluginError(
          `${where}: returned "replace" without a "value" object. A replaced node ` +
            `produces a state, so the value is the output object that node would ` +
            `have returned.`,
        );
      }
      return { action: 'replace', value: raw.value };
    }

    case 'retry': {
      const { delayMs } = raw;
      if (delayMs !== undefined && (typeof delayMs !== 'number' || !Number.isFinite(delayMs))) {
        throw new PluginError(
          `${where}: returned "retry" with a delayMs of ${JSON.stringify(delayMs)}, ` +
            `which is not a number of milliseconds.`,
        );
      }
      return delayMs === undefined
        ? { action: 'retry' }
        : { action: 'retry', delayMs };
    }

    case 'fail': {
      if (typeof raw.reason !== 'string' || raw.reason.length === 0) {
        throw new PluginError(
          `${where}: returned "fail" without a "reason". The reason replaces the ` +
            `error the run would otherwise have reported, so an empty one loses the ` +
            `only diagnosis anybody had.`,
        );
      }
      return { action: 'fail', reason: raw.reason };
    }
  }
}

/**
 * What every reverse call names, besides its own payload.
 *
 * One process serves every component of one plugin, and the channel the call
 * arrives on belongs to the plugin rather than to any one call on it. So each
 * reverse call has to say which `execute` or `apply` it was made inside, for
 * three reasons.
 *
 * **Attribution.** Concurrent calls on one plugin are ordinary. The host keeps
 * the reporter heddle built for each call it dispatched, and this id is what
 * selects it. That is also what keeps `componentType` out of the plugin's
 * hands: the namespace an event is published under comes from the entry heddle
 * is executing, never from these params, so the worst a plugin can do by naming
 * the wrong id is misattribute its own event to another of its own nodes.
 *
 * **Scope.** A `runTool` names the call for a different reason, and it is the
 * one that made this field general rather than reporting-only. The tool has to
 * run in the *node's* tool scope — the same sandbox session whose workspace
 * heddle sent as {@link ExecuteParams.workspace} — or a plugin that writes a
 * file and names it to `runTool` hands the tool a path that is not there on its
 * side. Without the id the host has only its own process-wide runner, which
 * opens a throwaway session per call, and the two halves of the documented
 * contract come apart under exactly the sandboxing that contract exists for.
 *
 * **The clock.** A call's timeout is a silence budget — see `PluginHost.call` —
 * and a plugin reporting steadily is not silent. Naming the call is what lets
 * `emitEvent` and `log` reset it, so a plugin that spends ten minutes and says
 * so throughout is not killed for saying so. `runTool` does not reset it: the
 * host is inside that call for its whole duration, so a plugin waiting on a
 * tool has already stopped being the thing the budget is measuring.
 *
 * Optional on the wire in one direction only: a plugin that names no call is
 * served from the host's own runner, so hand-rolled plugins written before this
 * field existed keep working. A report has no such fallback, because there is
 * nothing to attribute it to.
 */
interface InFlight extends Record<string, unknown> {
  /** The id of the `execute` or `apply` request this was made inside. */
  call: number | string;
}

/**
 * Params for `runTool`, sent by the plugin.
 *
 * `call` is inherited rather than declared here, and it is not optional in the
 * type: heddle's own inlined runtime always sends it, because a tool that runs
 * outside the calling node's scope cannot see the workspace that node was
 * given. The host tolerates its absence for plugins that hand-roll the protocol
 * — see `serveRunTool` — but nothing heddle emits should rely on that.
 */
export interface RunToolParams extends InFlight {
  name: string;
  input: Record<string, unknown>;
}

/** Params for `emitEvent`: publish one event on the run's stream. */
export interface EmitEventParams extends InFlight {
  /**
   * The plugin's half of the event type, and the only half it supplies. heddle
   * publishes the event as `plugin:<componentType>:<name>`, so no spelling of
   * this names a builtin. See `pluginEventType` for the shape it has to have.
   */
  name: string;
  /**
   * The event's payload, opaque to heddle and passed to the client verbatim.
   *
   * Necessarily serializable, having arrived as JSON — which is why the host
   * cannot be the place a bad payload is caught for a remote plugin. The
   * inlined runtime refuses one in the plugin's own process, at the call that
   * built it, where the failure still names the event.
   */
  data?: unknown;
}

/** Params for `log`: one line about the run, for a person. */
export interface LogParams extends InFlight {
  level: LogLevel;
  message: string;
}

/**
 * Params for `callModel`: one model call, on the component's own `llm_config`.
 *
 * {@link ModelRequest} is `ChatRequest` without `model`, and the missing field
 * is the design. A plugin says what to ask; the spec says who to ask, at which
 * endpoint, on whose credential — so a flow's author can read the document they
 * submitted and know every model their run will reach, which is exactly what
 * they could *not* know if the plugin named its own.
 *
 * The answer is a {@link ChatResponse} verbatim, so a plugin sees the same
 * object an `AgentNode` sees, and buffered: see `PluginModel.call` for why a
 * plugin's model call does not stream.
 */
export interface CallModelParams extends InFlight, ModelRequest {}

const ROLES: Record<Role, true> = {
  system: true,
  user: true,
  assistant: true,
  tool: true,
};

/** Named for an error message, since "the second message" is what an author counts. */
function at(index: number): string {
  return `messages[${index}]`;
}

/** `typeof` with the two answers it gets wrong spelled out. */
function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

/**
 * Read one message that arrived from a plugin's process.
 *
 * `Message` is a TypeScript interface, which says nothing about a value parsed
 * out of a pipe. Every field checked here has a specific way of failing further
 * away if it is not: an unknown `role` falls off the end of `buildMessages`'s
 * switch and reaches the endpoint as `undefined`; a `tool` message without
 * `tool_call_id` is sent with the field literally absent, which OpenAI rejects
 * with a message naming neither the plugin nor the call. Checked here, each is
 * the plugin's own `callModel` failing and saying which message was wrong.
 */
function readMessage(raw: unknown, index: number): Message {
  if (!isObject(raw)) {
    throw new PluginError(`callModel: ${at(index)} is ${typeName(raw)}, not a message object`);
  }
  const { role, content, tool_calls: toolCalls, tool_call_id: toolCallId } = raw;

  if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) {
    throw new PluginError(
      `callModel: ${at(index)} has role ${JSON.stringify(role)}; expected one of ` +
        `${Object.keys(ROLES).join(', ')}.`,
    );
  }
  if (typeof content !== 'string') {
    throw new PluginError(
      `callModel: ${at(index)} has no "content" string. A message with nothing to ` +
        `say is still written as "".`,
    );
  }

  const message: Message = { role: role as Role, content };

  if (role === 'tool') {
    if (typeof toolCallId !== 'string') {
      throw new PluginError(
        `callModel: ${at(index)} is a tool message with no "tool_call_id". A tool ` +
          `result answers a specific call, and the model matches them by that id.`,
      );
    }
    message.tool_call_id = toolCallId;
  }

  if (toolCalls !== undefined) {
    if (!Array.isArray(toolCalls)) {
      throw new PluginError(`callModel: ${at(index)} has a "tool_calls" that is not an array`);
    }
    message.tool_calls = toolCalls.map((call, i) => {
      if (
        !isObject(call) ||
        typeof call.id !== 'string' ||
        typeof call.name !== 'string' ||
        typeof call.arguments !== 'string'
      ) {
        throw new PluginError(
          `callModel: ${at(index)}.tool_calls[${i}] needs a string "id", "name" and ` +
            `"arguments". "arguments" is the JSON the model wrote, as text — not the ` +
            `parsed object.`,
        );
      }
      return { id: call.id, name: call.name, arguments: call.arguments };
    });
  }

  return message;
}

function readNumber(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PluginError(
      `callModel: "${key}" is ${JSON.stringify(value)}, which is not a number.`,
    );
  }
  return value;
}

/**
 * Read a `callModel` frame into the request heddle will send.
 *
 * Rebuilt field by field rather than cast, and absent fields left absent rather
 * than set to `undefined`: the caller merges this over the spec's
 * `default_generation_parameters`, so an `undefined` present in the object
 * would erase a default the plugin never mentioned.
 */
export function readModelRequest(params: Record<string, unknown> | undefined): ModelRequest {
  const raw = params ?? {};

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new PluginError(
      'callModel needs a non-empty "messages" array: the conversation to send. A ' +
        'call with nothing to say has no answer to return.',
    );
  }

  const request: ModelRequest = { messages: raw.messages.map(readMessage) };

  if (raw.tools !== undefined) {
    if (!Array.isArray(raw.tools)) {
      throw new PluginError('callModel: "tools" is not an array');
    }
    request.tools = raw.tools.map((tool, i): ToolDefinition => {
      if (!isObject(tool) || typeof tool.name !== 'string' || !isObject(tool.parameters)) {
        throw new PluginError(
          `callModel: tools[${i}] needs a string "name" and a "parameters" JSON ` +
            `Schema object. Describing a tool to the model does not run it — that is ` +
            `runTool, and it is granted separately.`,
        );
      }
      return {
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description : '',
        parameters: tool.parameters,
      };
    });
  }

  const temperature = readNumber(raw, 'temperature');
  if (temperature !== undefined) request.temperature = temperature;
  const maxTokens = readNumber(raw, 'maxTokens');
  if (maxTokens !== undefined) request.maxTokens = maxTokens;
  const topP = readNumber(raw, 'topP');
  if (topP !== undefined) request.topP = topP;

  if (raw.responseFormat !== undefined) {
    if (raw.responseFormat !== 'text' && raw.responseFormat !== 'json') {
      throw new PluginError(
        `callModel: "responseFormat" is ${JSON.stringify(raw.responseFormat)}; ` +
          `expected "text" or "json".`,
      );
    }
    request.responseFormat = raw.responseFormat;
  }

  return request;
}

/**
 * The levels a `log` frame may carry, as data.
 *
 * `LogLevel` is a type, and a type checks nothing about a string that arrived
 * from another process. Keyed by the type rather than written as an array so
 * that a level added to `LogLevel` and forgotten here is a compile error,
 * instead of a value the host refuses after the type said it was fine.
 */
const LEVELS: Record<LogLevel, true> = {
  debug: true,
  info: true,
  warn: true,
  error: true,
};

/** The closed set a `log` frame's `level` is checked against. */
export const LOG_LEVELS = Object.keys(LEVELS) as LogLevel[];

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

export function encode(message: RpcMessage): string {
  // A newline inside the payload would split one message into two, so the
  // encoder must never emit one. JSON.stringify escapes newlines in strings,
  // and the object form it produces contains none of its own.
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into messages.
 *
 * Holds the trailing partial line between chunks: a pipe gives no guarantee
 * that a write arrives as one read, and a plugin that emits a large result
 * will routinely be delivered in pieces.
 */
export class LineDecoder {
  private buffer = '';

  /** Feed a chunk, returning whatever complete lines it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    // The last element is either a partial line or '' when the chunk ended
    // exactly on a newline. Either way it is not yet a message.
    this.buffer = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }

  /** Anything left unterminated when the stream closed. */
  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : undefined;
  }
}
