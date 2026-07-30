import type { LLMConfig, LLMNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import type { Provider } from '../llm/types.js';
import { completeChat, substituteTemplate } from './agent.js';
import { generationParams, providerFor } from '../llm/provider.js';
import { RunError } from '../errors.js';

export class LLMExecutor implements NodeExecutor {
  private readonly node: LLMNode;
  private readonly deps: Dependencies;
  private readonly llmConfig: LLMConfig;
  private readonly generation: ReturnType<typeof generationParams>;
  private provider?: Provider;

  constructor(node: LLMNode, deps: Dependencies) {
    if (!node.llmConfig) {
      throw new RunError(`LlmNode "${node.name}": node has no llmConfig`);
    }

    this.node = node;
    this.deps = deps;
    this.llmConfig = node.llmConfig;
    this.generation = generationParams(node.llmConfig);
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const prompt = substituteTemplate(this.node.promptTemplate, input);

    const response = await completeChat(
      this.getProvider(),
      signal,
      {
        model: this.llmConfig.modelId,
        messages: [{ role: 'user', content: prompt }],
        ...this.generation,
      },
      {
        nodeName: this.node.name,
        eventHandler: this.deps.eventHandler,
        allowStream: this.deps.stream !== false,
      },
    );

    return new State({ generated_text: response.content });
  }

  private getProvider(): Provider {
    this.provider ??= providerFor(this.llmConfig, this.deps);
    return this.provider;
  }
}
