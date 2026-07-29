/**
 * LLM config types barrel export.
 */
import { z } from "zod";
import { registerLlmConfigSchema } from "./lazy-schemas.js";
import { OpenAiCompatibleConfigSchema } from "./openai-compatible-config.js";
import { OllamaConfigSchema } from "./ollama-config.js";
import { VllmConfigSchema } from "./vllm-config.js";
import { OpenAiConfigSchema } from "./openai-config.js";
import { OciGenAiConfigSchema } from "./oci-genai-config.js";

/** Discriminated union of all LLM config types */
export const LlmConfigUnion = z.discriminatedUnion("componentType", [
  OpenAiCompatibleConfigSchema,
  OllamaConfigSchema,
  VllmConfigSchema,
  OpenAiConfigSchema,
  OciGenAiConfigSchema,
]);

export type LlmConfig = z.infer<typeof LlmConfigUnion>;

// Self-registers the way flows/nodes/index.ts, flows/flow.ts and
// transforms/message-transform.ts do, so the lazy reference resolves to the
// real union for any consumer that has loaded this module. Every consumer of
// LazyLlmConfigRef imports it from here rather than from lazy-schemas.js
// directly, which is what guarantees that.
registerLlmConfigSchema(LlmConfigUnion);

export {
  LazyLlmConfigRef,
  registerLlmConfigSchema,
} from "./lazy-schemas.js";

export {
  LlmGenerationConfigSchema,
  OpenAIAPIType,
  type LlmGenerationConfig,
} from "./llm-config.js";

export {
  OpenAiCompatibleConfigSchema,
  createOpenAiCompatibleConfig,
  type OpenAiCompatibleConfig,
} from "./openai-compatible-config.js";

export {
  OllamaConfigSchema,
  createOllamaConfig,
  type OllamaConfig,
} from "./ollama-config.js";

export {
  VllmConfigSchema,
  createVllmConfig,
  type VllmConfig,
} from "./vllm-config.js";

export {
  OpenAiConfigSchema,
  createOpenAiConfig,
  type OpenAiConfig,
} from "./openai-config.js";

export {
  OciGenAiConfigSchema,
  createOciGenAiConfig,
  ServingMode,
  ModelProvider,
  OciAPIType,
  type OciGenAiConfig,
} from "./oci-genai-config.js";

export {
  OciClientConfigUnion,
  OciClientConfigWithApiKeySchema,
  OciClientConfigWithInstancePrincipalSchema,
  OciClientConfigWithResourcePrincipalSchema,
  OciClientConfigWithSecurityTokenSchema,
  createOciClientConfigWithApiKey,
  createOciClientConfigWithInstancePrincipal,
  createOciClientConfigWithResourcePrincipal,
  createOciClientConfigWithSecurityToken,
  type OciClientConfig,
  type OciClientConfigWithApiKey,
  type OciClientConfigWithInstancePrincipal,
  type OciClientConfigWithResourcePrincipal,
  type OciClientConfigWithSecurityToken,
} from "./oci-client-config.js";
