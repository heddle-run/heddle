import type { MiddlewareChain } from '../plugin/middleware.js';
import type { EventHandler } from './events.js';

/** Options configures runner behavior. */
export interface RunnerOptions {
  maxIterations: number;
  timeout: number;
  /**
   * Advisory only: the engine never writes to stdout or stderr. Consumers may
   * consult this when deciding how much detail to render from the events they
   * receive via {@link eventHandler}.
   */
  verbose: boolean;
  eventHandler?: EventHandler;
  /**
   * How many times one arrival at a node may be attempted.
   *
   * A ceiling on {@link middleware}'s `retry`, and defence in depth rather than
   * the bound: a retry spends an iteration, so `maxIterations` and the run
   * timeout already stop a middleware that asks forever. What this adds is that
   * they stop it *at the node*, with a message naming the middleware, instead
   * of at the graph with a message about iterations.
   *
   * Per arrival. A node inside a loop gets a fresh budget each time the flow
   * reaches it, because a node that failed twice an hour ago says nothing about
   * this visit — and the aggregate is bounded by `maxIterations` regardless,
   * since every attempt spends one.
   *
   * A RunnerOption rather than a module constant, so it does not repeat
   * `MAX_TOOL_ROUNDS`'s mistake of being unreachable from any configuration.
   */
  maxNodeAttempts: number;
  /**
   * Middleware installed by whoever runs heddle, consulted at the seams it
   * subscribed to. Absent means nothing is installed, which is the default and
   * costs nothing.
   */
  middleware?: MiddlewareChain;
}

export const DEFAULT_RUNNER_OPTIONS: Readonly<RunnerOptions> = {
  maxIterations: 50,
  timeout: 300_000, // 5 minutes
  verbose: false,
  maxNodeAttempts: 3,
};
