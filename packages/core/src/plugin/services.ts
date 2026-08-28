import { generationParams, providerFor } from '../llm/provider.js';
import type { ChatResponse, ModelRequest, Provider } from '../llm/types.js';
import type { ModelSpec } from '../spec/types.js';
import { BUILTIN_PROVIDERS } from '../spec/types.js';
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
  model?: unknown;
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
  private config?: ModelSpec;

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
      model: config.model,
    });
  }

  private readConfig(): ModelSpec {
    const raw = this.component.model;

    if (raw === undefined) {
      throw new PluginError(missingConfigMessage(this.where));
    }
    if (!isObject(raw)) {
      throw new PluginError(wrongConfigShapeMessage(this.where, raw));
    }

    const config = raw as Record<string, unknown>;
    if (typeof config.provider !== 'string' || config.provider.length === 0) {
      throw new PluginError(missingFieldMessage(this.where, 'provider'));
    }
    if (typeof config.model !== 'string' || config.model.length === 0) {
      throw new PluginError(missingFieldMessage(this.where, 'model'));
    }

    const known = new Set(['provider', 'model', 'url', 'api_key', 'params']);
    const extra: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(config)) {
      if (!known.has(key)) extra[key] = value;
    }

    const spec: ModelSpec = {
      provider: config.provider,
      model: config.model,
      extra,
    };
    if (typeof config.url === 'string') spec.url = config.url;
    if (typeof config.api_key === 'string') spec.api_key = config.api_key;
    if (isObject(config.params)) spec.params = config.params;

    return spec;
  }
}

function missingConfigMessage(where: string): string {
  return (
    `${where}: callModel needs a "model" on this component, and it has ` +
    `none. A plugin composes the request; the document chooses the model, ` +
    `so add the same model an agent would carry:\n` +
    `  model:\n` +
    `    provider: openai   # or ${BUILTIN_PROVIDERS.join(', ')}\n` +
    `    model: gpt-4o-mini`
  );
}

function wrongConfigShapeMessage(where: string, raw: unknown): string {
  return `${where}: "model" is ${typeName(raw)}, not a model object.`;
}

function missingFieldMessage(where: string, field: string): string {
  return (
    `${where}: this component's "model" has no "${field}". Every model ` +
    `names its provider and its model id.`
  );
}
