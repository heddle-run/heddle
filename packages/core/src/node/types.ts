import type { State } from '../state/state.js';
import type { Executor, Registry } from '../tool/types.js';
import type { EventHandler } from '../runner/events.js';
import type { LLMConfig } from '../spec/types.js';
import type { Provider } from '../llm/types.js';
import type { ProviderOptions } from '../llm/provider.js';
import type { PluginRegistry } from '../plugin/registry.js';

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
}
