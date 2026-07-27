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
        // Parsed once, here, and used by everything downstream. This used to be
        // parsed twice — leniently for the event, strictly for the call — so an
        // observer saw `{}` for arguments the tool never ran with. Anything
        // watching a tool call has to be looking at what the tool was given.
        const parsed = parseToolArguments(tc);

        const startedAt = Date.now();
        this.deps.eventHandler?.({
          type: 'tool_call',
          nodeName: this.node.name,
          toolName: tc.name,
          toolArgs: parsed.args,
          toolCallId: tc.id,
          startedAt,
        });

        try {
          // Thrown inside the try so an unusable arguments blob is reported the
          // way any other tool failure is: a tool_result carrying the error,
          // and a tool message telling the model what went wrong so it can
          // correct itself on the next round.
          if (parsed.error) throw parsed.error;
          const toolResult = await this.executeTool(signal, tc, parsed.args, executor);
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
    args: Record<string, unknown>,
    scoped: Executor | undefined,
  ): Promise<Record<string, unknown>> {
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

/**
 * The single reading of a tool call's arguments.
 *
 * Hands the failure back instead of throwing it, so the caller can announce the
 * call before it fails: an observer that never sees a `tool_call` cannot make
 * sense of the `tool_result` error that follows it.
 *
 * A blob that parses to something other than a JSON object is refused for the
 * same reason a malformed one is. Otherwise a bare array or `null` reaches the
 * executor typed as named arguments, and the tool fails somewhere further away
 * from the model that wrote them.
 *
 * Nothing here throws, and that is a contract the caller relies on: it is
 * called outside the try/catch that turns a tool failure into a `tool_result`,
 * so anything raised out of it fails the whole agent node instead.
 */
function parseToolArguments(tc: ToolCall): {
  args: Record<string, unknown>;
  error?: ToolError;
} {
  // `ToolCall.arguments` is typed `string`, but it is assigned straight from an
  // endpoint's JSON in llm/openai.ts, and a spec names its own `llm_config.url`.
  // The type is therefore a hope about the remote server, not a fact: an
  // OpenAI-compatible endpoint that omits `function.arguments` would otherwise
  // reach `.slice` on `undefined` and throw out of the agent node entirely,
  // taking the run with it. Coerced here so the failure stays what every other
  // bad tool call is — a tool_result error the model can correct next round.
  const raw = typeof tc.arguments === 'string' ? tc.arguments : '';

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    // A blank blob is what the missing-field case looks like by the time it
    // gets here, and "Got: " with nothing after it tells whoever is debugging a
    // flaky endpoint nothing at all.
    const got = raw.trim() === '' ? 'nothing at all' : raw.slice(0, 200);
    return {
      args: {},
      error: new ToolError(
        `"${tc.name}" was called with arguments that are not JSON. ` +
          `Send a JSON object of named arguments. Got: ${got}`,
        { cause: err },
      ),
    };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : `a ${typeof value}`;
    return {
      args: {},
      error: new ToolError(
        `"${tc.name}" was called with ${got}. Send a JSON object of named arguments.`,
      ),
    };
  }

  return { args: value as Record<string, unknown> };
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
