import { generationParams, providerFor } from '../llm/provider.js';
import type { ChatResponse, ModelRequest, Provider } from '../llm/types.js';
import type { LLMConfig } from '../spec/types.js';
import type { Dependencies } from '../node/types.js';
import type { Executor, Registry } from '../tool/types.js';
import { invokeTool } from '../tool/invoke.js';
import { isObject, typeName } from '../internal/util.js';
import { PluginError, RunError, ToolError } from '../errors.js';

export type ToolRunner = (
  name: string,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export type ModelCaller = (request: ModelRequest) => Promise<ChatResponse>;

interface ConfigHolder {
  llmConfig?: unknown;
  [key: string]: unknown;
}

/**
 * Look a tool up, run it, and hand back its output.
 *
 * One function because it is one contract, reached from three places — a
 * plugin node's `runTool`, a middleware's, and an agent's own tool loop.
 * `where` is who asked, for the error's sake; the executor is the caller's
 * choice, because a scoped executor is a per-node fact this function has no
 * business deciding.
 */
export async function runNamedTool(
  where: string,
  registry: Registry | undefined,
  executor: Executor | undefined,
  signal: AbortSignal | undefined,
  name: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!registry) {
    throw new RunError(`${where}: no tool registry configured`);
  }

  const tool = registry.lookup(name);
  if (!tool) {
    throw new ToolError(`${where}: tool "${name}" not found`);
  }

  const result = await invokeTool(signal, tool, input, executor);
  return result.output;
}

export function toolRunner(where: string, deps: Dependencies): ToolRunner {
  return (name, input) =>
    runNamedTool(where, deps.toolRegistry, deps.toolExecutor, undefined, name, input);
}

export class PluginModel {
  private provider?: Provider;
  private config?: LLMConfig;

  constructor(
    private readonly where: string,
    private readonly component: ConfigHolder,
    private readonly deps: Dependencies,
  ) {}

  bind(signal: AbortSignal | undefined): ModelCaller {
    return (request) => this.call(request, signal);
  }

  private async call(
    request: ModelRequest,
    signal: AbortSignal | undefined,
  ): Promise<ChatResponse> {
    const config = (this.config ??= this.readConfig());
    this.provider ??= providerFor(config, this.deps);

    return this.provider.chatCompletion(signal, {
      ...generationParams(config),
      ...request,
      model: config.modelId,
    });
  }

  private readConfig(): LLMConfig {
    const raw = this.component.llmConfig;

    if (raw === undefined) {
      throw new PluginError(missingConfigMessage(this.where));
    }
    if (!isObject(raw)) {
      throw new PluginError(wrongConfigShapeMessage(this.where, raw));
    }

    const config = raw as Partial<LLMConfig>;
    if (typeof config.modelId !== 'string' || config.modelId.length === 0) {
      throw new PluginError(missingModelIdMessage(this.where));
    }

    return config as LLMConfig;
  }
}

function missingConfigMessage(where: string): string {
  return (
    `${where}: callModel needs an "llm_config" on this component, and it ` +
    `has none. A plugin composes the request; the spec chooses the model, so ` +
    `add the same llm_config an agent would carry:\n` +
    `  llm_config:\n` +
    `    component_type: OpenAiConfig\n` +
    `    model_id: gpt-4o-mini`
  );
}

function wrongConfigShapeMessage(where: string, raw: unknown): string {
  return `${where}: "llm_config" is ${typeName(raw)}, not a config object.`;
}

function missingModelIdMessage(where: string): string {
  return (
    `${where}: "llm_config" has no "model_id". Every config names the ` +
    `model it reaches, and heddle sends it verbatim.`
  );
}
