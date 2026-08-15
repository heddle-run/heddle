import type { LlmStep, ModelSpec } from '../spec/types.js';
import { renderTemplate } from '../spec/template.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import type { Provider } from '../llm/types.js';
import { completeChat } from './agent.js';
import { generationParams, providerFor } from '../llm/provider.js';

/** A single completion, no tools. Writes `text`. */
export class LLMExecutor implements NodeExecutor {
  private readonly step: LlmStep;
  private readonly deps: Dependencies;
  private readonly model: ModelSpec;
  private readonly generation: ReturnType<typeof generationParams>;
  private provider?: Provider;

  constructor(step: LlmStep, deps: Dependencies) {
    this.step = step;
    this.deps = deps;
    this.model = step.model;
    this.generation = generationParams(step.model);
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const prompt = renderTemplate(
      this.step.prompt,
      input,
      `step "${this.step.name}"`,
    );

    const response = await completeChat(
      this.getProvider(),
      signal,
      {
        model: this.model.model,
        messages: [{ role: 'user', content: prompt }],
        ...this.generation,
      },
      {
        nodeName: this.step.name,
        nodeType: 'llm',
        middleware: this.deps.middleware,
        eventHandler: this.deps.eventHandler,
        allowStream: this.deps.stream !== false,
      },
    );

    return new State({ text: response.content });
  }

  private getProvider(): Provider {
    this.provider ??= providerFor(this.model, this.deps);
    return this.provider;
  }
}
