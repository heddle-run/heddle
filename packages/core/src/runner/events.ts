import type { State } from '../state/state.js';
import { PluginError } from '../errors.js';

/**
 * The events heddle emits about a run on its own account.
 *
 * Closed, and it stays closed. Every one of these is a claim only the engine is
 * in a position to make — that a flow finished, that a node failed, that this
 * fragment came out of a model — and consumers act on them: a client that sees
 * `flow_complete` stops waiting, a client that sees `node_error` reports a
 * failure to a person. Membership of this union is therefore the right to be
 * believed, which is why the plugin half of {@link EventType} is built so that
 * nothing outside heddle can join it. See {@link PluginEventType}.
 */
export type BuiltinEventType =
  | 'node_start'
  | 'node_complete'
  | 'node_error'
  | 'flow_start'
  | 'flow_complete'
  | 'tool_call'
  | 'tool_result'
  | 'token_delta'
  | 'plugin_log'
  | 'warning';

/** The prefix heddle puts in front of every event a plugin asks it to emit. */
export const PLUGIN_EVENT_PREFIX = 'plugin:';

/**
 * An event a plugin emitted, published as `plugin:<componentType>:<name>`.
 *
 * **A plugin supplies only `<name>`.** heddle builds the rest, in
 * {@link pluginEventType}, and that is what makes forging a builtin
 * *structurally* impossible instead of checked and rejected: every string this
 * type admits begins with `plugin:`, no {@link BuiltinEventType} does, so the
 * two halves of {@link EventType} cannot overlap however a plugin spells its
 * name. A plugin asking for `flow_complete` gets `plugin:LlmJudge:flow_complete`
 * and lies to nobody. There is no list of reserved names to keep up to date,
 * and no check to forget when the next builtin type is added.
 *
 * `<componentType>` is in the name because namespacing is about collision as
 * well as forgery. Two plugins both emitting `progress`, with different `data`
 * inside it, would leave a bare `plugin:progress` with no payload contract at
 * all. With the component type in the type, every event has exactly one owner
 * and therefore one shape — which is what a client switching on the SSE event
 * name, and any future encoder, are relying on.
 */
export type PluginEventType = `${typeof PLUGIN_EVENT_PREFIX}${string}`;

/** Everything that can appear as an {@link Event}'s `type`. */
export type EventType = BuiltinEventType | PluginEventType;

/** How loud a `plugin_log` is. Ordered from least to most urgent. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * What each segment of a plugin event type has to look like.
 *
 * The same shape a manifest already demands of a `componentType`, applied to
 * the plugin's half of the name too, for two reasons. The event type *is* the
 * SSE event name, and that is the one part of a frame written to the wire
 * without JSON escaping — so a name carrying a newline would end the frame
 * early and let a plugin write frames of its own, which is exactly the forgery
 * the prefix exists to prevent, reached around the type system. And it is what
 * clients switch on, so it has to be spellable as an identifier in whatever
 * they happen to be written in.
 */
const SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build the wire type for an event a plugin asked to emit.
 *
 * The only way to obtain a {@link PluginEventType}, and the only place the
 * prefix is written. A caller passes the component heddle itself instantiated
 * and the short name the plugin chose; it cannot pass a finished type.
 */
export function pluginEventType(
  componentType: string,
  name: string,
): PluginEventType {
  if (!SEGMENT.test(componentType)) {
    throw new PluginError(
      `component type "${componentType}" cannot appear in an event type. heddle ` +
        `publishes a plugin's events as "${PLUGIN_EVENT_PREFIX}<componentType>:<name>", ` +
        `and every segment has to match ${SEGMENT.source}. Rename the component type.`,
    );
  }
  if (!SEGMENT.test(name)) {
    throw new PluginError(
      `"${name}" is not a usable event name. This event is published as ` +
        `"${PLUGIN_EVENT_PREFIX}${componentType}:${name}", so the name is its last ` +
        `segment and has to match ${SEGMENT.source} — letters, digits and ` +
        `underscores, starting with a letter or underscore. Try "progress" or ` +
        `"row_written".`,
    );
  }
  return `${PLUGIN_EVENT_PREFIX}${componentType}:${name}`;
}

/**
 * Whether this event came from a plugin rather than from the engine.
 *
 * The test consumers need before trusting an event's meaning, and the readable
 * form of the disjointness above: a `true` here means `data` is a plugin's
 * shape and the type's second segment names whose.
 */
export function isPluginEvent(type: EventType): type is PluginEventType {
  return type.startsWith(PLUGIN_EVENT_PREFIX);
}

/** Event holds information about a runner event. */
export interface Event {
  type: EventType;
  /** Human-readable detail, set on `warning` and on `plugin_log`. */
  message?: string;
  /**
   * The text a `token_delta` carries: one fragment of a model's answer, in the
   * order the model produced it.
   *
   * **Concatenating a node's deltas does not reconstruct its output**, and two
   * ordinary configurations make that so. An agent that calls tools streams
   * every round it makes, including the rounds whose text is thrown away when
   * the tool results supersede them — so the concatenation holds text the node
   * never returned. An agent carrying a `post` transform does not stream at
   * all, because a delta that has reached a browser cannot be recalled once the
   * transform rejects the answer — so the concatenation is empty for a node
   * that produced plenty. See `completeChat` in `node/agent.ts` for both.
   *
   * A delta is a report, not a result. A run can fail after emitting fifty of
   * them, and the node then has no output at all — so nothing downstream may
   * treat accumulated deltas as the answer.
   */
  delta?: string;
  /**
   * The payload of a plugin-emitted event, exactly as the plugin passed it.
   *
   * Only ever set on a {@link PluginEventType}: the engine's own events say
   * what they mean in named fields, and a builtin type carrying an untyped bag
   * would be a second, weaker way to say the same things. Its shape belongs to
   * whichever component the type names — heddle does not read it, and a
   * consumer that does needs to know that plugin.
   */
  data?: unknown;
  /**
   * How urgent a `plugin_log` is. Absent on every other type, because nothing
   * else in this union is a message *about* the run rather than a fact *of* it.
   */
  level?: LogLevel;
  nodeName?: string;
  nodeType?: string;
  state?: State;
  error?: Error;
  /**
   * Which attempt at this node produced the event, 1-based. Set on
   * `node_start`, `node_complete` and `node_error`.
   *
   * It exists because middleware made `node_error` non-terminal. Before it, an
   * error event meant the run was over and a client could say so; now a
   * `nodeError` middleware can retry, so the same node can fail, be re-entered
   * and succeed, and a consumer reading two `node_start`s for one node has no
   * other way to tell a retry from a loop revisiting it. A client that ignores
   * this field renders a retried node exactly as it renders a loop, which is
   * the old behaviour and is why the field is additive rather than a new type.
   */
  attempt?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  toolCallId?: string;
  startedAt?: number;
  duration?: number;
}

/** EventHandler receives events during flow execution. */
export type EventHandler = (event: Event) => void;
