import type { LLMNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import { completeChat, substituteTemplate } from './agent.js';
import { createProvider, generationParams } from '../llm/provider.js';
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
    const provider = createProvider(this.node.llmConfig, {
      allowEnvRefs: this.deps.allowEnvRefs,
      defaultKey: this.deps.defaultLlmKey,
      defaultUrl: this.deps.defaultLlmUrl,
    });
    const model = this.node.llmConfig.modelId;

    const prompt = substituteTemplate(this.node.promptTemplate, input);

    // An LlmNode is a single prompt with no tools, which is the case streaming
    // helps most: it is one long answer with nothing else to watch. Same helper
    // as AgentExecutor, so both nodes stream or buffer on the same rule and a
    // consumer sees one kind of `token_delta`.
    const resp = await completeChat(
      provider,
      signal,
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        ...generationParams(this.node.llmConfig),
      },
      {
        nodeName: this.node.name,
        eventHandler: this.deps.eventHandler,
        // An LlmNode has no transforms, so the operator's setting is the only
        // veto here.
        allowStream: this.deps.stream !== false,
      },
    );

    let output = new State();
    output = output.set('generated_text', resp.content);
    return output;
  }
}
