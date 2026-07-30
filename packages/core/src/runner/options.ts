import type { MiddlewareChain } from '../plugin/middleware.js';
import type { EventHandler } from './events.js';

export interface RunnerOptions {
  maxIterations: number;
  timeout: number;
  verbose: boolean;
  eventHandler?: EventHandler;
  maxNodeAttempts: number;
  middleware?: MiddlewareChain;
}

const FIVE_MINUTES_IN_MS = 300_000;

export const DEFAULT_RUNNER_OPTIONS: Readonly<RunnerOptions> = {
  maxIterations: 50,
  timeout: FIVE_MINUTES_IN_MS,
  verbose: false,
  maxNodeAttempts: 3,
};
