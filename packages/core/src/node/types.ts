import type { State } from '../state/state.js';
import type { Executor, Registry } from '../tool/types.js';
import type { EventHandler } from '../runner/events.js';
import type { LLMConfig } from '../spec/types.js';
import type { Provider } from '../llm/types.js';
import type { ProviderOptions } from '../llm/provider.js';

/** NodeExecutor executes a node and returns the output state. */
export interface NodeExecutor {
  execute(signal: AbortSignal | undefined, input: State): Promise<State>;
  branch(): string;
}

/** Dependencies holds shared dependencies for node executors. */
export interface Dependencies {
  toolExecutor?: Executor;
  toolRegistry?: Registry;
  /** Custom component types contributed by plugins. */
  plugins?: import('../plugin/registry.js').PluginRegistry;
  eventHandler?: EventHandler;
  /**
   * Whether `$VAR` in a spec's llm_config may read the host environment.
   * Defaults to true. Set false wherever specs arrive from callers: the
   * reference is not restricted to model credentials, so it is a read of the
   * process environment that the spec's author chooses.
   */
  allowEnvRefs?: boolean;
  /**
   * A credential the operator supplies for specs that name none. Only ever
   * used with `defaultLlmUrl`; a spec that chooses its own endpoint must bring
   * its own key. See `applyDefaultCredential`.
   */
  defaultLlmKey?: string;
  defaultLlmUrl?: string;
  /**
   * How to build a provider for one of the config types the SDK ships.
   *
   * Defaults to `createProvider`, which is the OpenAI-compatible client every
   * builtin config resolves to. Present so that construction is substitutable
   * at all: it used to be a directly-imported free function called from three
   * places, so an embedder wanting to route model calls through their own
   * client — or a test wanting a stub — had no choice but to mock the module,
   * which substitutes it for code that never asked.
   *
   * **This does not cover plugin providers, deliberately.** `providerFor`
   * consults the registry first and only falls through to here for a builtin
   * type, so overriding this replaces heddle's own construction without also
   * disabling every `llm_config` type a plugin supplies. The two are different
   * questions — "how does heddle build an OpenAI client" and "who answers for
   * `AnthropicConfig`" — and one field answering both would mean an embedder
   * silently turned off a feature the operator loaded.
   */
  createProvider?: (config: LLMConfig, options: ProviderOptions) => Provider;

  /**
   * Whether a model call may stream when the provider offers a streamed form.
   * Defaults to true. Set false to force the buffered request.
   *
   * An operator-level choice, alongside the other two, because whether `stream`
   * is safe to send is a property of the endpoint and the deployment, not of
   * the flow: the same spec has to run against a proxy that only handles
   * buffered requests, or one that prices streamed calls differently, without
   * being rewritten. A spec field would attach the answer to the wrong thing —
   * a spec is portable and the endpoint it lands on is not.
   *
   * Not a fallback. A streamed call that fails is not re-sent buffered, because
   * the first one may already have been billed; this is decided before the
   * request goes out or not at all. See `completeChat`.
   */
  stream?: boolean;
}
