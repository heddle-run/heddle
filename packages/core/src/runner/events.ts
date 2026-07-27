import type { State } from '../state/state.js';

/** EventType represents a runner lifecycle event. */
export type EventType =
  | 'node_start'
  | 'node_complete'
  | 'node_error'
  | 'flow_start'
  | 'flow_complete'
  | 'tool_call'
  | 'tool_result'
  | 'token_delta'
  | 'warning';

/** Event holds information about a runner event. */
export interface Event {
  type: EventType;
  /** Human-readable detail, currently only set on `warning`. */
  message?: string;
  /**
   * The text a `token_delta` carries: one fragment of a model's answer, in the
   * order the model produced it. Concatenating every delta of one node's turn
   * gives the same text that node would have produced without streaming.
   *
   * A delta is a report, not a result. A run can fail after emitting fifty of
   * them, and the node then has no output at all — so nothing downstream may
   * treat accumulated deltas as the answer.
   */
  delta?: string;
  nodeName?: string;
  nodeType?: string;
  state?: State;
  error?: Error;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  toolCallId?: string;
  startedAt?: number;
  duration?: number;
}

/** EventHandler receives events during flow execution. */
export type EventHandler = (event: Event) => void;
