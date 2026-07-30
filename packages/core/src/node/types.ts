import type { State } from '../state/state.js';
import type { Executor, Registry } from '../tool/types.js';
import type { EventHandler } from '../runner/events.js';
import type { LLMConfig } from '../spec/types.js';
import type { Provider } from '../llm/types.js';
import type { ProviderOptions } from '../llm/provider.js';
import type { EgressPolicy } from '../llm/egress.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { MiddlewareChain } from '../plugin/middleware.js';

export interface NodeExecutor {
  execute(signal: AbortSignal | undefined, input: State): Promise<State>;
  branch(): string;
}

export interface Dependencies {
  toolExecutor?: Executor;
  toolRegistry?: Registry;
  plugins?: PluginRegistry;
  eventHandler?: EventHandler;
  allowEnvRefs?: boolean;
  defaultLlmKey?: string;
  defaultLlmUrl?: string;
  createProvider?: (config: LLMConfig, options: ProviderOptions) => Provider;
  stream?: boolean;
  /**
   * Middleware installed by whoever runs heddle, for the seams that sit *inside*
   * a node rather than around one.
   *
   * The same chain `RunnerOptions` carries, and it is here as well because the
   * two reach different call sites. `nodeError` is consulted by the runner,
   * which has the chain already; `toolCall` is consulted inside an agent's tool
   * loop, which has only its `Dependencies`. Passing it twice is better than the
   * alternatives — a runner that reaches into node internals, or an executor
   * that is handed `RunnerOptions` and could read the run's whole configuration.
   *
   * Absent means nothing is installed, which is the default and costs nothing:
   * the call site checks `hasBefore` before it consults, so a run with no
   * middleware never touches the chain.
   */
  middleware?: MiddlewareChain;
  /**
   * Where a spec heddle did not write may send heddle's own requests.
   *
   * Set by the server when it accepts submitted specs, and absent everywhere
   * else — running your own spec on your own machine needs no such rule, and
   * one would refuse a local Ollama for nothing.
   */
  egress?: EgressPolicy;
}
