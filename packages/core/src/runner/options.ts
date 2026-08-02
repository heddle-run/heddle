import type { MiddlewareChain } from '../plugin/middleware.js';
import type { EventHandler } from './events.js';

/**
 * Where a run stopped, in the runner's own terms.
 *
 * Four values, which is all of `walk`'s position — and every one is JSON or a
 * name. There is no closure here and no live handle, which is why cutting a run
 * at a node boundary is nearly free and why this is the granularity to start
 * at. What it does not reach is anything inside one node's `execute`.
 */
export interface RunPosition {
  /** The node to re-enter. */
  node: string;
  carried: Record<string, unknown>;
  nodeOutputs: Record<string, Record<string, unknown>>;
  attempt: number;
}

/**
 * Somewhere to put a run's position, and to take it away again.
 *
 * Deliberately not a `SessionStore`. The runner does not know what a session
 * is, and should not have to — it knows where it got to, and something else
 * decides that this belongs to a conversation. That is also what lets a test
 * checkpoint into an array.
 */
export interface CheckpointSink {
  save(position: RunPosition): Promise<void>;
  /**
   * A middleware stopped the run on a human.
   *
   * Separate from {@link save} because the two are asked for separately. A
   * per-node save is a cost the caller opts into with `durable`; this one is
   * not optional — a suspension that went unrecorded would be a run stopped
   * with no way back, which is worse than one that never stopped.
   */
  suspend(position: RunPosition, suspension: SuspensionRecord): Promise<void>;
  /** The run finished. Nothing is left to resume. */
  clear(): Promise<void>;
}

/**
 * What the runner knows about a suspension.
 *
 * `resume` is opaque here and stays that way: it belongs to the executor that
 * wrote it, and the runner's only job is to carry it back.
 */
export interface SuspensionRecord {
  by: string;
  seam: string;
  ask: Record<string, unknown>;
  node: string;
  resume: Record<string, unknown>;
}

export interface RunnerOptions {
  maxIterations: number;
  timeout: number;
  verbose: boolean;
  eventHandler?: EventHandler;
  maxNodeAttempts: number;
  middleware?: MiddlewareChain;
  /**
   * Somewhere to write this run down, if it has anywhere.
   *
   * Present whenever the run belongs to a conversation — which is not the same
   * as asking for per-node checkpoints. A run with a sink and `durable` off
   * writes nothing until something suspends it, and then writes once. Without a
   * sink at all, a middleware that suspends is an error: there would be no way
   * back.
   */
  checkpoints?: CheckpointSink;
  /**
   * Whether to record the position after every node.
   *
   * One store write per node, which is why it is asked for rather than implied.
   * Off, the run is still resumable *if a human stops it* — that is what makes
   * the two settings separate rather than one.
   */
  durable?: boolean;
}

const FIVE_MINUTES_IN_MS = 300_000;

export const DEFAULT_RUNNER_OPTIONS: Readonly<RunnerOptions> = {
  maxIterations: 50,
  timeout: FIVE_MINUTES_IN_MS,
  verbose: false,
  maxNodeAttempts: 3,
};
