import type { AgentNode, ToolSpec } from '../spec/types.js';
import { propertyTitle } from '../spec/types.js';
import { State } from '../state/state.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Message,
  ToolCall,
  ToolDefinition,
  Provider,
  JsonSchema,
} from '../llm/types.js';
import type { NodeExecutor, Dependencies } from './types.js';
import type { EventHandler } from '../runner/events.js';
import type { Executor } from '../tool/types.js';
import { createProvider, generationParams } from '../llm/provider.js';
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
  /**
   * The spec's generation settings, read once. Here rather than per round
   * because they cannot change between rounds, and because a spec that sets
   * them wrongly should say so when the flow is compiled — beside the transform
   * check below, which fails for the same reason.
   */
  private generation: ReturnType<typeof generationParams>;

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
    this.generation = generationParams(agent.llmConfig);
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

    // One counter for the whole turn, not one per round — see ModelCallContext.
    const turn = { emitted: 0 };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const resp = await completeChat(
        this.getProvider(),
        signal,
        {
          model: this.model,
          messages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          ...this.generation,
        },
        {
          nodeName: this.node.name,
          eventHandler: this.deps.eventHandler,
          // Two independent vetoes. The operator may have said this deployment
          // does not stream at all, and a `post` transform can reject this
          // answer — a delta already sent cannot be recalled. See completeChat.
          allowStream:
            this.deps.stream !== false && !this.transforms.hasPhase('post'),
          turn,
        },
      );

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

/** Who to tell about deltas, and which node they belong to. */
export interface ModelCallContext {
  nodeName: string;
  eventHandler?: EventHandler;
  /**
   * Whether this call may stream. Defaults to true. Two callers set it false,
   * for two unrelated reasons — the operator turned streaming off for this
   * deployment, or a `post` transform can reject the answer. See
   * {@link completeChat}.
   */
  allowStream?: boolean;
  /**
   * Deltas already sent this *turn*, shared across the rounds of one agent
   * node so the abandonment warning knows what a client is holding.
   *
   * A per-call count gets this wrong in the case that matters: round one
   * streams half an answer, round two calls a tool and fails before writing
   * anything, and a count local to round two is zero — so no warning goes out
   * while round one's text is still on someone's screen. Callers that make a
   * single model call can leave it undefined.
   */
  turn?: { emitted: number };
}

/**
 * One model call, streamed when the provider can and buffered when it cannot.
 *
 * The two paths return the same {@link ChatResponse}, and that is the whole
 * contract: nothing after this function can tell which one ran. The streaming
 * path's only visible difference is that `token_delta` events arrive while the
 * answer is still being written.
 *
 * **A `post` transform turns streaming off.** A transform in that phase can
 * reject or rewrite the model's answer, and heddle's guardrail story rests on
 * it: `transform_status: rejected` is supposed to mean the answer did not get
 * out. Streaming breaks that, because a `token_delta` has already left the
 * process — and, through the server's SSE stream, already reached a browser —
 * by the time the transform is asked. Redacting the copy in `State` afterwards
 * changes what the flow returns and nothing about what was shown.
 *
 * Buffering the deltas until the transform passes would not fix it either; it
 * would just be a slower way to not stream. So an agent with a `post` transform
 * does not stream at all. That is a real cost — the guardrail examples are
 * exactly the flows a person most wants to watch arrive — and it is the correct
 * trade until a transform can run on the stream itself rather than after it.
 *
 * **A mid-stream failure fails the node.** This is the part streaming changes.
 * A buffered call fails before anyone has seen anything; a stream can fail
 * after half an answer has been shown to a client. The half is not salvaged
 * and the call is not retried: salvaging would let a truncated answer become
 * the node's output with nothing marking it as truncated, and retrying would
 * bill the caller twice and emit the same prefix again to observers who
 * already have it. Instead the error propagates, exactly as the buffered
 * failure would, preceded by a `warning` that says the deltas already sent are
 * being abandoned — because a client holding half an answer and a dead stream
 * otherwise has no way to know which it is.
 */
export async function completeChat(
  provider: Provider,
  signal: AbortSignal | undefined,
  req: ChatRequest,
  ctx: ModelCallContext,
): Promise<ChatResponse> {
  if (!provider.chatCompletionStream || ctx.allowStream === false) {
    return provider.chatCompletion(signal, req);
  }

  const turn = ctx.turn ?? { emitted: 0 };
  try {
    return await collectStream(
      provider.chatCompletionStream(signal, req),
      (text) => {
        turn.emitted++;
        ctx.eventHandler?.({
          type: 'token_delta',
          nodeName: ctx.nodeName,
          delta: text,
        });
      },
    );
  } catch (err) {
    if (turn.emitted > 0) {
      ctx.eventHandler?.({
        type: 'warning',
        nodeName: ctx.nodeName,
        message:
          `"${ctx.nodeName}": the model stream failed after ${turn.emitted} token ` +
          `deltas had already been sent. Those deltas are not this node's ` +
          `output — nothing was produced. Discard the partial text rather ` +
          `than showing it as an answer. Cause: ${
            err instanceof Error ? err.message : String(err)
          }`,
      });
    }
    throw err;
  }
}

/**
 * Accumulate a stream into the response the buffered call would have returned.
 *
 * `onContent` fires per content fragment rather than per chunk, so a chunk
 * carrying only tool-call fragments produces no delta: a caller forwarding
 * these to a client is showing text to a person, and the half-written JSON of
 * a tool call is not text for a person.
 */
export async function collectStream(
  chunks: AsyncIterable<ChatChunk>,
  onContent?: (text: string) => void,
): Promise<ChatResponse> {
  let content = '';
  let finishReason = '';
  // Keyed by the delta's index for the reason given on `ToolCallDelta`:
  // fragments after the first carry no id to key on.
  const calls = new Map<number, ToolCall>();

  for await (const chunk of chunks) {
    if (chunk.content) {
      content += chunk.content;
      onContent?.(chunk.content);
    }

    for (const delta of chunk.tool_calls ?? []) {
      const call = calls.get(delta.index) ?? { id: '', name: '', arguments: '' };
      // Last non-empty wins for id and name, which arrive once; arguments is
      // the only field that accumulates.
      if (delta.id) call.id = delta.id;
      if (delta.name) call.name = delta.name;
      if (delta.arguments) call.arguments += delta.arguments;
      calls.set(delta.index, call);
    }

    if (chunk.finish_reason) finishReason = chunk.finish_reason;
  }

  const resp: ChatResponse = { content, finish_reason: finishReason };

  // Absent rather than empty when there were none: `resp.tool_calls = []`
  // would be a different response from the one the buffered path returns, and
  // the agent loop branches on exactly this.
  if (calls.size > 0) {
    // By index, not by arrival: a provider is free to interleave the fragments
    // of two calls, and the order the tools run in has to be the order the
    // model asked for.
    resp.tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call);
  }

  return resp;
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
