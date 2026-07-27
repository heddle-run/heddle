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
 *
 * A response always carries the id of the request it answers, and each side
 * only tracks ids it issued itself, so the two id spaces never have to agree.
 *
 * stderr is not part of the protocol. It is left to the plugin for logging and
 * is surfaced verbatim when the process fails, which is where a plugin author
 * will look first.
 */

/**
 * Methods heddle calls on a plugin, each mapped to the params it carries.
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

export type RpcMessage = RpcRequest | RpcResponse;

export function isRequest(message: RpcMessage): message is RpcRequest {
  return typeof (message as RpcRequest).method === 'string';
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
