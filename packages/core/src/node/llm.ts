import type { LLMNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { substituteTemplate } from './agent.js';
import { createProvider } from '../llm/provider.js';
import { RunError } from '../errors.js';

/** LLMExecutor executes an LlmNode by running a prompt template through the LLM. */
export class LLMExecutor implements NodeExecutor {
  private node: LLMNode;
  private deps: Dependencies;

  constructor(node: LLMNode, deps: Dependencies) {
    this.node = node;
    this.deps = deps;
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    if (!this.node.llmConfig) {
      throw new RunError(
        `LlmNode "${this.node.name}": node has no llmConfig`,
      );
    }

    // Resolve LLM provider from the spec's llmConfig
    const provider = createProvider(this.node.llmConfig);
    const model = this.node.llmConfig.modelId;

    const prompt = substituteTemplate(this.node.promptTemplate, input);

    const resp = await provider.chatCompletion(signal, {
      model,
      messages: [{ role: 'user', content: prompt }],
    });

    let output = new State();
    output = output.set('generated_text', resp.content);
    return output;
  }
}
