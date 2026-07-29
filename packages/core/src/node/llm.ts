import type { LLMNode } from '../spec/types.js';
import { State } from '../state/state.js';
import type { NodeExecutor, Dependencies } from './types.js';
import type { Provider } from '../llm/types.js';
import { completeChat, substituteTemplate } from './agent.js';
import { generationParams, providerFor } from '../llm/provider.js';
import { RunError } from '../errors.js';

/** LLMExecutor executes an LlmNode by running a prompt template through the LLM. */
export class LLMExecutor implements NodeExecutor {
  private node: LLMNode;
  private deps: Dependencies;
  private provider?: Provider;
  /** The spec's generation settings, read once — see {@link AgentExecutor}. */
  private generation: ReturnType<typeof generationParams>;

  constructor(node: LLMNode, deps: Dependencies) {
    this.node = node;
    this.deps = deps;

    if (!node.llmConfig) {
      throw new RunError(`LlmNode "${node.name}": node has no llmConfig`);
    }
    this.generation = generationParams(node.llmConfig);
  }

  /**
   * One provider for the life of the compiled graph, built on first use.
   *
   * This node used to build a fresh one on every execution, and the difference
   * only became visible when a provider could be a plugin: one holding a
   * connection pool, a token bucket or a response cache would have had it
   * discarded and rebuilt each time a flow reached this node, so the state it
   * existed to keep would have been silently dropped. `AgentExecutor` memoized
   * from the start; this is the same lifetime, arrived at late.
   *
   * Lazy for `AgentExecutor.getProvider`'s reason: executors are constructed by
   * `compile()`, and building a provider can throw when no credential is
   * configured — so an eager one would make validating any flow with an
   * `LlmNode` impossible without a key.
   */
  private getProvider(): Provider {
    this.provider ??= providerFor(this.node.llmConfig!, this.deps);
    return this.provider;
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const provider = this.getProvider();
    const model = this.node.llmConfig!.modelId;

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
        ...this.generation,
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
