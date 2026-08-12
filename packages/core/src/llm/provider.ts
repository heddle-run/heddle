import { BUILTIN_PROVIDERS, type ModelSpec } from '../spec/types.js';
import type { ChatRequest, Provider } from './types.js';
import type { Dependencies } from '../node/types.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { PluginComponent } from '../plugin/types.js';
import { pluginComponentOf } from '../spec/resolve.js';
import { OpenAIProvider } from './openai.js';
import { LLMError } from '../errors.js';
import { isSet } from '../internal/util.js';
import { envRefKey, isEnvRef } from './env-refs.js';
import {
  assertEgressAllowed,
  redirectRefusingFetch,
  type EgressPolicy,
} from './egress.js';

type Generation = Pick<ChatRequest, 'temperature' | 'maxTokens' | 'topP'>;

const GENERATION_KEYS: Array<[keyof Generation, string]> = [
  ['temperature', 'temperature'],
  ['maxTokens', 'max_tokens'],
  ['topP', 'top_p'],
];

/** Where an `ollama` model with no `url` is reached. */
const OLLAMA_URL = 'http://localhost:11434/v1';

export interface ProviderOptions {
  allowEnvRefs?: boolean;
  defaultUrl?: string;
  defaultKey?: string;
  /**
   * Where a spec heddle did not write may send heddle's own requests.
   *
   * Absent means unrestricted, which is the CLI running your own spec on your
   * own machine. See `egress.ts` for what the policy refuses and, more
   * importantly, what it does not.
   */
  egress?: EgressPolicy;
}

export function isBuiltinProvider(provider: string): boolean {
  return BUILTIN_PROVIDERS.includes(provider);
}

export function providerFor(model: ModelSpec, deps: Dependencies): Provider {
  if (!isBuiltinProvider(model.provider)) {
    const registry = deps.plugins;
    if (registry) {
      return pluginProvider(model, registry, deps);
    }
  }

  const build = deps.createProvider ?? createProvider;
  return build(model, {
    allowEnvRefs: deps.allowEnvRefs,
    defaultKey: deps.defaultLlmKey,
    defaultUrl: deps.defaultLlmUrl,
    egress: deps.egress,
  });
}

export function createProvider(
  model: ModelSpec,
  options: ProviderOptions = {},
): Provider {
  if (!isBuiltinProvider(model.provider)) {
    throw new LLMError(
      `unsupported provider "${model.provider}". ` +
        `Builtin: ${BUILTIN_PROVIDERS.join(', ')}.`,
    );
  }

  const clientOptions: {
    apiKey?: string;
    baseURL?: string;
    fetch?: typeof fetch;
  } = {};

  // Under a policy, every request this client makes refuses a redirect — not
  // only the ones naming a url. An operator's default endpoint can be
  // redirected too, and the caller chose the spec that reached it.
  if (options.egress) {
    clientOptions.fetch = redirectRefusingFetch(
      `provider "${model.provider}"`,
    );
  }

  if (model.api_key) {
    clientOptions.apiKey = resolveEnvVar(
      model.api_key,
      options.allowEnvRefs ?? true,
    );
  }

  const url = model.url ?? implicitUrl(model.provider);
  if (url) {
    // Before it becomes a base URL, because after that it is a connection this
    // process makes from wherever this process sits.
    assertEgressAllowed(url, options.egress, `provider "${model.provider}"`);
    clientOptions.baseURL = url;
  }
  if (model.provider === 'ollama' && !clientOptions.apiKey) {
    // Ollama ignores the key but the client insists on one.
    clientOptions.apiKey = 'ollama';
  }
  applyDefaultCredential(clientOptions, model, options);

  return new OpenAIProvider(clientOptions);
}

function implicitUrl(provider: string): string | undefined {
  return provider === 'ollama' ? OLLAMA_URL : undefined;
}

export function generationParams(model: ModelSpec): Generation {
  const raw = model.params;
  if (!raw) return {};

  const params: Generation = {};
  for (const [requestKey, paramKey] of GENERATION_KEYS) {
    const value = raw[paramKey];
    if (!isSet(value)) continue;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LLMError(nonNumericGenerationMessage(paramKey, value));
    }
    params[requestKey] = value;
  }
  return params;
}

function pluginProvider(
  model: ModelSpec,
  registry: PluginRegistry,
  deps: Dependencies,
): Provider {
  const definition = registry.providerDef(model.provider);
  if (definition) {
    return definition.createProvider(providerComponent(model), deps);
  }

  const kind = registry.kindOf(model.provider);
  if (kind) {
    throw new LLMError(wrongPluginKindMessage(model.provider, kind));
  }

  throw new LLMError(unsupportedProviderMessage(model.provider, registry));
}

/** The shape a plugin provider is handed: the model entry, as a component. */
function providerComponent(model: ModelSpec): PluginComponent {
  const config: Record<string, unknown> = {
    model: model.model,
    ...model.extra,
  };
  if (model.url !== undefined) config.url = model.url;
  if (model.api_key !== undefined) config.api_key = model.api_key;
  if (model.params !== undefined) config.params = model.params;

  return pluginComponentOf(model.provider, model.provider, config);
}

function applyDefaultCredential(
  clientOptions: { apiKey?: string; baseURL?: string },
  model: ModelSpec,
  options: ProviderOptions,
): void {
  const { defaultUrl, defaultKey } = options;
  if (!defaultKey || clientOptions.apiKey) return;

  if (model.url) {
    throw new LLMError(
      `this model sets "url" but no "api_key". The server's own credential ` +
        `is only used with its own endpoint, so a flow that chooses where to ` +
        `send requests has to supply the key for them.`,
    );
  }

  clientOptions.apiKey = defaultKey;
  if (defaultUrl) clientOptions.baseURL = defaultUrl;
}

function resolveEnvVar(value: string, allowEnvRefs: boolean): string {
  if (!isEnvRef(value)) return value;

  if (!allowEnvRefs) {
    throw new LLMError(refusedEnvRefMessage(value));
  }

  const key = envRefKey(value);
  const resolved = process.env[key];
  if (!resolved) {
    throw new LLMError(
      `environment variable "${key}" is not set (referenced as "${value}" in the document)`,
    );
  }
  return resolved;
}

function refusedEnvRefMessage(value: string): string {
  return (
    `"${value}" refers to an environment variable. This server does not resolve ` +
    `those for documents it did not write — the reference is not limited to model ` +
    `keys, and the same document chooses where the value would be sent. Put the ` +
    `credential in the document, or omit it and use whatever this server provides. ` +
    `Running the document yourself, ${value} resolves normally.`
  );
}

function nonNumericGenerationMessage(key: string, value: unknown): string {
  return (
    `params.${key} is ${JSON.stringify(value)}, which is not a number. ` +
    `These are sent to the model as written, so a string here is either ` +
    `rejected by the endpoint or silently ignored by it.`
  );
}

function wrongPluginKindMessage(provider: string, kind: string): string {
  return (
    `the provider "${provider}" is provided by a plugin as a ${kind} rather ` +
    `than a provider. Only a "provider" component supplies a model endpoint; ` +
    `a ${kind} is written somewhere else in the document.`
  );
}

function unsupportedProviderMessage(
  provider: string,
  registry: PluginRegistry,
): string {
  return (
    `unsupported provider "${provider}". Builtin: ` +
    `${BUILTIN_PROVIDERS.join(', ')}.\n` +
    `  Loaded plugins: ${registry.describe()}\n` +
    `  If it comes from a plugin, load it with: --plugin <module>`
  );
}
