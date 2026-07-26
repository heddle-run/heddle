import type { AgentNode, ToolSpec } from '../spec/types.js';
import { propertyTitle } from '../spec/types.js';
import { State } from '../state/state.js';
import type { Message, ToolCall, ToolDefinition, Provider, JsonSchema } from '../llm/types.js';
import type { NodeExecutor, Dependencies } from './types.js';
import type { Executor } from '../tool/types.js';
import { createProvider } from '../llm/provider.js';
import { TransformChain } from '../plugin/transform.js';
import { RunError, ToolError } from '../errors.js';

const MAX_TOOL_ROUNDS = 10;

/** AgentExecutor executes an AgentNode with LLM + tool-calling loop. */
export class AgentExecutor implements NodeExecutor {
  private node: AgentNode;
  private deps: Dependencies;
  private model: string;
  private provider?: Provider;
  private transforms: TransformChain;

  constructor(node: AgentNode, deps: Dependencies) {
    this.node = node;
    this.deps = deps;

    const agent = node.agent;
    if (!agent?.llmConfig) {
      throw new RunError(
        `AgentNode "${node.name}": agent or llmConfig is missing`,
      );
    }
    this.model = agent.llmConfig.modelId;
    // Built here so a misconfigured transform fails at compile time.
    this.transforms = TransformChain.build(
      agent.transforms,
      deps,
      agent.name ?? node.name,
    );
  }

  /**
   * Providers are built on first use, not in the constructor.
   *
   * Constructing an OpenAI client throws when no API key is configured, and
   * executors are constructed by `compile()`. Doing it eagerly would make
   * compiling — and therefore validating — any flow containing an agent node
   * impossible without credentials.
   */
  private getProvider(): Provider {
    this.provider ??= createProvider(this.node.agent!.llmConfig!, {
      allowEnvRefs: this.deps.allowEnvRefs,
      defaultKey: this.deps.defaultLlmKey,
      defaultUrl: this.deps.defaultLlmUrl,
    });
    return this.provider;
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    // One sandbox session per agent execution: this agent's tools share a
    // workspace with each other and with nothing else. Torn down on the way
    // out, however the run ends.
    const scope = this.deps.toolExecutor?.beginScope?.(this.node.name);
    try {
      return await this.runAgent(signal, input, scope?.executor);
    } finally {
      scope?.dispose();
    }
  }

  private async runAgent(
    signal: AbortSignal | undefined,
    input: State,
    executor: Executor | undefined,
  ): Promise<State> {
    const agent = this.node.agent!;

    const systemPrompt = substituteTemplate(
      agent.systemPrompt ?? '',
      input,
    );

    const toolDefs: ToolDefinition[] = agent.tools?.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      parameters: buildToolSchema(t),
    })) ?? [];

    // Extract chat history if present (injected by chat mode)
    const historyRaw = input.get('_chat_history');
    const chatHistory = Array.isArray(historyRaw)
      ? (historyRaw as Array<{ role: string; content: string }>)
      : [];

    // Build input data without the chat history for the user message
    const inputData = input.toData();
    delete inputData._chat_history;

    let messages: Message[] = [
      { role: 'system', content: systemPrompt },
      ...chatHistory.map((m) => ({
        role: m.role as Message['role'],
        content: m.content,
      })),
      { role: 'user', content: JSON.stringify(inputData) },
    ];

    // Pre-transforms run before the model is called at all, so a rejected
    // prompt costs nothing.
    const pre = await this.transforms.apply('pre', messages, signal);
    if (pre.rejected) {
      return rejectionState(pre.rejected);
    }
    messages = pre.messages;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await this.getProvider().chatCompletion(signal, {
        model: this.model,
        messages,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
      });

      if (!resp.tool_calls || resp.tool_calls.length === 0) {
        // Post-transforms see the answer in the context of the conversation
        // that produced it, with the reply as the last message.
        const post = await this.transforms.apply(
          'post',
          [...messages, { role: 'assistant', content: resp.content }],
          signal,
        );
        if (post.rejected) {
          return rejectionState(post.rejected);
        }
        const content = post.messages.at(-1)?.content ?? resp.content;

        const outputData: Record<string, unknown> = { result: content };
        if (content) {
          try {
            Object.assign(outputData, JSON.parse(content));
          } catch {
            // Not JSON, that's fine
          }
        }
        // Only when the agent has transforms, so an untransformed agent's output
        // shape is unchanged. Set last: a model returning JSON cannot forge it.
        if (!this.transforms.isEmpty()) {
          outputData.transform_status = 'ok';
        }
        return new State(outputData);
      }

      messages.push({
        role: 'assistant',
        content: resp.content,
        tool_calls: resp.tool_calls,
      });

      for (const tc of resp.tool_calls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.arguments);
        } catch {
          args = {};
        }

        const startedAt = Date.now();
        this.deps.eventHandler?.({
          type: 'tool_call',
          nodeName: this.node.name,
          toolName: tc.name,
          toolArgs: args,
          toolCallId: tc.id,
          startedAt,
        });

        try {
          const toolResult = await this.executeTool(signal, tc, executor);
          const resultJSON = JSON.stringify(toolResult);

          this.deps.eventHandler?.({
            type: 'tool_result',
            nodeName: this.node.name,
            toolName: tc.name,
            toolResult: toolResult,
            toolCallId: tc.id,
            duration: Date.now() - startedAt,
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: resultJSON,
          });
        } catch (err) {
          const toolErr = err instanceof Error ? err : new Error(String(err));

          this.deps.eventHandler?.({
            type: 'tool_result',
            nodeName: this.node.name,
            toolName: tc.name,
            toolCallId: tc.id,
            duration: Date.now() - startedAt,
            error: toolErr,
          });

          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: `Error: ${err}`,
          });
        }
      }
    }

    throw new RunError(
      `AgentNode "${this.node.name}" exceeded max tool rounds (${MAX_TOOL_ROUNDS})`,
    );
  }

  private async executeTool(
    signal: AbortSignal | undefined,
    tc: ToolCall,
    scoped: Executor | undefined,
  ): Promise<Record<string, unknown>> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.arguments);
    } catch (err) {
      throw new ToolError(`failed to parse arguments for "${tc.name}"`, { cause: err });
    }

    const executor = scoped ?? this.deps.toolExecutor;
    if (!this.deps.toolRegistry || !executor) {
      throw new ToolError(`"${tc.name}": registry or executor not configured`);
    }

    const toolDef = this.deps.toolRegistry.lookup(tc.name);
    if (!toolDef) {
      throw new ToolError(`"${tc.name}" not found in registry`);
    }

    const result = await executor.execute(signal, toolDef.path, args);

    return result.output;
  }
}

/** Substitute {{key}} placeholders in a template string. */
export function substituteTemplate(template: string, s: State): string {
  let result = template;
  for (const key of s.keys()) {
    result = result.replaceAll(`{{${key}}}`, s.getString(key) ?? '');
  }
  return result;
}

/**
 * The agent's output when a transform refused. `transform_status` is a plain
 * state key, so a downstream BranchingNode can route on it without heddle
 * inventing any branching of its own.
 */
function rejectionState(rejected: {
  reason: string;
  transform: string;
  phase: string;
  replacement?: string;
}): State {
  return new State({
    result: rejected.replacement ?? rejected.reason,
    transform_status: 'rejected',
    transform_reason: rejected.reason,
    transform_name: rejected.transform,
    transform_phase: rejected.phase,
  });
}

/** Build a JSON Schema object from a ToolSpec's inputs. */
export function buildToolSchema(t: ToolSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  if (t.inputs) {
    for (const input of t.inputs) {
      const name = propertyTitle(input);
      if (!name) continue;
      const prop: JsonSchema = {};
      for (const [k, v] of Object.entries(input.jsonSchema)) {
        if (k !== 'title') {
          prop[k] = v;
        }
      }
      properties[name] = prop;
      required.push(name);
    }
  }

  return {
    type: 'object',
    properties,
    required,
  };
}
