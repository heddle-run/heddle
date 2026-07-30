import { isBuiltinComponentType } from 'agentspec';
import type { LLMConfig } from '../spec/types.js';
import type { ChatRequest, Provider } from './types.js';
import type { Dependencies } from '../node/types.js';
import type { PluginRegistry } from '../plugin/registry.js';
import type { PluginComponent } from '../plugin/types.js';
import { OpenAIProvider } from './openai.js';
import { LLMError } from '../errors.js';

const OPENAI_COMPATIBLE_TYPES = new Set([
  'OpenAiConfig',
  'OpenAiCompatibleConfig',
  'VllmConfig',
  'OllamaConfig',
]);

const ENV_REF_PREFIX = '$';

type Generation = Pick<ChatRequest, 'temperature' | 'maxTokens' | 'topP'>;

const GENERATION_KEYS: Array<[keyof Generation, string]> = [
  ['temperature', 'temperature'],
  ['maxTokens', 'max_tokens'],
  ['topP', 'top_p'],
];

export interface ProviderOptions {
  allowEnvRefs?: boolean;
  defaultUrl?: string;
  defaultKey?: string;
}

export function isBuiltinConfigType(componentType: string): boolean {
  return OPENAI_COMPATIBLE_TYPES.has(componentType);
}

export function providerFor(config: LLMConfig, deps: Dependencies): Provider {
  const componentType = config.componentType;

  if (componentType && !isBuiltinConfigType(componentType)) {
    assertNotUnbuildableSdkType(componentType);

    const registry = deps.plugins;
    if (registry) {
      return pluginProvider(componentType, config, registry, deps);
    }
  }

  const build = deps.createProvider ?? createProvider;
  return build(config, {
    allowEnvRefs: deps.allowEnvRefs,
    defaultKey: deps.defaultLlmKey,
    defaultUrl: deps.defaultLlmUrl,
  });
}

export function createProvider(
  config: LLMConfig,
  options: ProviderOptions = {},
): Provider {
  const configType = config.componentType ?? 'OpenAiConfig';
  if (!OPENAI_COMPATIBLE_TYPES.has(configType)) {
    throw new LLMError(
      `unsupported config type "${configType}". ` +
        `Supported: ${supportedTypes()}`,
    );
  }

  const clientOptions: { apiKey?: string; baseURL?: string } = {};

  if (config.apiKey) {
    clientOptions.apiKey = resolveEnvVar(
      config.apiKey,
      options.allowEnvRefs ?? true,
    );
  }
  if (config.url) {
    clientOptions.baseURL = config.url;
  }
  applyDefaultCredential(clientOptions, config, options);

  return new OpenAIProvider(clientOptions);
}

export function generationParams(config: LLMConfig): Generation {
  const raw = config.defaultGenerationParameters;
  if (!raw) return {};

  const params: Generation = {};
  for (const [camelCase, snakeCase] of GENERATION_KEYS) {
    const written = isSet(raw[camelCase]) ? camelCase : snakeCase;
    const value = raw[written];
    if (!isSet(value)) continue;

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new LLMError(nonNumericGenerationMessage(written, value));
    }
    params[camelCase] = value;
  }
  return params;
}

function pluginProvider(
  componentType: string,
  config: LLMConfig,
  registry: PluginRegistry,
  deps: Dependencies,
): Provider {
  const definition = registry.providerDef(componentType);
  if (definition) {
    return definition.createProvider(
      config as unknown as PluginComponent,
      deps,
    );
  }

  const kind = registry.kindOf(componentType);
  if (kind) {
    throw new LLMError(wrongPluginKindMessage(componentType, kind));
  }

  throw new LLMError(unsupportedConfigTypeMessage(componentType, registry));
}

function assertNotUnbuildableSdkType(componentType: string): void {
  if (!isBuiltinComponentType(componentType)) return;

  throw new LLMError(
    `llm_config has type "${componentType}", which Agent Spec defines but heddle ` +
      `has no client for. heddle speaks: ${supportedTypes()}. ` +
      `No plugin can supply it either — a plugin may not claim a builtin component ` +
      `type — so this flow needs one of those, or an endpoint reached through ` +
      `OpenAiCompatibleConfig.`,
  );
}

function applyDefaultCredential(
  clientOptions: { apiKey?: string; baseURL?: string },
  config: LLMConfig,
  options: ProviderOptions,
): void {
  const { defaultUrl, defaultKey } = options;
  if (!defaultKey || config.apiKey) return;

  if (config.url) {
    throw new LLMError(
      `this llm_config sets "url" but no "api_key". The server's own credential ` +
        `is only used with its own endpoint, so a flow that chooses where to send ` +
        `requests has to supply the key for them.`,
    );
  }

  clientOptions.apiKey = defaultKey;
  if (defaultUrl) clientOptions.baseURL = defaultUrl;
}

function resolveEnvVar(value: string, allowEnvRefs: boolean): string {
  if (!value.startsWith(ENV_REF_PREFIX)) return value;

  if (!allowEnvRefs) {
    throw new LLMError(refusedEnvRefMessage(value));
  }

  const key = value.slice(ENV_REF_PREFIX.length);
  const resolved = process.env[key];
  if (!resolved) {
    throw new LLMError(
      `environment variable "${key}" is not set (referenced as "${value}" in spec)`,
    );
  }
  return resolved;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function supportedTypes(): string {
  return [...OPENAI_COMPATIBLE_TYPES].join(', ');
}

function refusedEnvRefMessage(value: string): string {
  return (
    `"${value}" refers to an environment variable. This server does not resolve ` +
    `those for specs it did not write — the reference is not limited to model ` +
    `keys, and the same spec chooses where the value would be sent. Put the ` +
    `credential in the spec, or omit it and use whatever this server provides. ` +
    `Running the spec yourself, ${value} resolves normally.`
  );
}

function nonNumericGenerationMessage(key: string, value: unknown): string {
  return (
    `default_generation_parameters.${key} is ${JSON.stringify(value)}, which is ` +
    `not a number. These are sent to the model as written, so a string here ` +
    `is either rejected by the endpoint or silently ignored by it.`
  );
}

function wrongPluginKindMessage(componentType: string, kind: string): string {
  return (
    `llm_config has type "${componentType}", which a plugin provides as a ` +
    `${kind} rather than a provider. Only a "provider" component supplies a ` +
    `model endpoint; a ${kind} is written somewhere else in the spec.`
  );
}

function unsupportedConfigTypeMessage(
  componentType: string,
  registry: PluginRegistry,
): string {
  return (
    `unsupported config type "${componentType}". Builtin: ` +
    `${supportedTypes()}.\n` +
    `  Loaded plugins: ${registry.describe()}\n` +
    `  If it comes from a plugin, load it with: --plugin <module>`
  );
}
