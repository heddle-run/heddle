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
}

export const DEFAULT_RUNNER_OPTIONS: Readonly<RunnerOptions> = {
  maxIterations: 50,
  timeout: 300_000, // 5 minutes
  verbose: false,
};
