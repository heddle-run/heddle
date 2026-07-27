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
const SERVED: Record<PluginMethod, true> = { runTool: true };

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
}

/** Params for `apply`: run one message transform. */
export interface ApplyParams extends Record<string, unknown> {
  componentType: string;
  component: Record<string, unknown>;
  phase: 'pre' | 'post';
  messages: unknown[];
}

/** Params for `runTool`, sent by the plugin. */
export interface RunToolParams extends Record<string, unknown> {
  name: string;
  input: Record<string, unknown>;
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
