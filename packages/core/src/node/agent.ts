import type { Agent, AgentNode, LLMConfig, ToolSpec } from '../spec/types.js';
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
import type { Executor, Registry } from '../tool/types.js';
import { invokeTool } from '../tool/invoke.js';
import type {
  ChainBefore,
  ChainVerdict,
  MiddlewareChain,
} from '../plugin/middleware.js';
import { readChatRequest, readChatResponse } from '../plugin/protocol.js';
import type { SeamOutcome } from '../plugin/types.js';
import { generationParams, providerFor } from '../llm/provider.js';
import { TransformChain } from '../plugin/transform.js';
import { LLMError, RunError, ToolError } from '../errors.js';

const MAX_TOOL_ROUNDS = 10;
const CHAT_HISTORY_KEY = '_chat_history';
const MAX_REPORTED_ARGUMENT_LENGTH = 200;

interface TurnCounter {
  emitted: number;
}

interface Rejection {
  reason: string;
  transform: string;
  phase: string;
  replacement?: string;
}

export class AgentExecutor implements NodeExecutor {
  private readonly node: AgentNode;
  private readonly deps: Dependencies;
  private readonly agent: Agent;
  private readonly llmConfig: LLMConfig;
  private readonly model: string;
  private readonly generation: ReturnType<typeof generationParams>;
  private readonly transforms: TransformChain;
  private provider?: Provider;

  constructor(node: AgentNode, deps: Dependencies) {
    const agent = node.agent;
    if (!agent?.llmConfig) {
      throw new RunError(
        `AgentNode "${node.name}": agent or llmConfig is missing`,
      );
    }

    this.node = node;
    this.deps = deps;
    this.agent = agent;
    this.llmConfig = agent.llmConfig;
    this.model = agent.llmConfig.modelId;
    this.generation = generationParams(agent.llmConfig);
    this.transforms = TransformChain.build(
      agent.transforms,
      deps,
      agent.name ?? node.name,
    );
  }

  branch(): string {
    return '';
  }

  async execute(
    signal: AbortSignal | undefined,
    input: State,
  ): Promise<State> {
    const scope = this.deps.toolExecutor?.beginScope?.(this.node.name);
    try {
      return await this.converse(signal, input, scope?.executor);
    } finally {
      scope?.dispose();
    }
  }

  private async converse(
    signal: AbortSignal | undefined,
    input: State,
    scopedExecutor: Executor | undefined,
  ): Promise<State> {
    const opening = await this.transforms.apply(
      'pre',
      this.openingMessages(input),
      signal,
    );
    if (opening.rejected) return rejectionState(opening.rejected);

    const messages = opening.messages;
    const tools = this.describeTools();
    const turn: TurnCounter = { emitted: 0 };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.callModel(signal, messages, tools, turn);

      if (!response.tool_calls || response.tool_calls.length === 0) {
        return await this.finish(signal, messages, response);
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls,
      });

      for (const call of response.tool_calls) {
        messages.push(await this.runToolCall(signal, call, scopedExecutor));
      }
    }

    throw new RunError(
      `AgentNode "${this.node.name}" exceeded max tool rounds (${MAX_TOOL_ROUNDS})`,
    );
  }

  private openingMessages(input: State): Message[] {
    return [
      {
        role: 'system',
        content: substituteTemplate(this.agent.systemPrompt ?? '', input),
      },
      ...chatHistoryOf(input),
      { role: 'user', content: JSON.stringify(inputWithoutHistory(input)) },
    ];
  }

  private describeTools(): ToolDefinition[] {
    return buildToolDefinitions(
      this.agent.tools,
      this.deps.toolRegistry,
      (message) => this.warn(message),
    );
  }

  private callModel(
    signal: AbortSignal | undefined,
    messages: Message[],
    tools: ToolDefinition[],
    turn: TurnCounter,
  ): Promise<ChatResponse> {
    return completeChat(
      this.getProvider(),
      signal,
      {
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        ...this.generation,
      },
      {
        nodeName: this.node.name,
        nodeType: 'AgentNode',
        middleware: this.deps.middleware,
        eventHandler: this.deps.eventHandler,
        allowStream:
          this.deps.stream !== false && !this.transforms.hasPhase('post'),
        turn,
      },
    );
  }

  private async finish(
    signal: AbortSignal | undefined,
    messages: Message[],
    response: ChatResponse,
  ): Promise<State> {
    const closing = await this.transforms.apply(
      'post',
      [...messages, { role: 'assistant', content: response.content }],
      signal,
    );
    if (closing.rejected) return rejectionState(closing.rejected);

    const answer = closing.messages.at(-1)?.content ?? response.content;
    const output = answerFields(answer);
    if (!this.transforms.isEmpty()) output.transform_status = 'ok';

    return new State(output);
  }

  private async runToolCall(
    signal: AbortSignal | undefined,
    call: ToolCall,
    scopedExecutor: Executor | undefined,
  ): Promise<Message> {
    const parsed = parseToolArguments(call);
    let args = withDefaults(parsed.args, this.agent.tools, call.name);
    const startedAt = Date.now();

    /**
     * Whatever a middleware decides, this method returns a message carrying
     * `call.id`.
     *
     * That is the invariant the whole seam is built around, and it is not
     * heddle's to choose: a provider refuses a request whose assistant message
     * asked for a tool call that no tool message answers. So a rejection is a
     * *reply* saying the call was refused, never a skipped turn — which is also
     * why the model can react to it, and why an approval gate is expressible at
     * all rather than just a way to break the conversation.
     */
    const gate = await this.beforeToolCall(signal, call, args);
    if (gate.action === 'modify') args = gate.input;

    if (gate.action === 'reject' || gate.action === 'replace') {
      const refused = gate.action === 'reject';
      this.warn(
        refused
          ? `"${gate.by}" refused the tool call "${call.name}": ${gate.reason}`
          : `"${gate.by}" supplied a result for "${call.name}" without running it.`,
      );

      this.deps.eventHandler?.({
        type: 'tool_result',
        nodeName: this.node.name,
        toolName: call.name,
        toolCallId: call.id,
        duration: Date.now() - startedAt,
        ...(refused
          ? { toolResult: { refused: true, reason: gate.reason } }
          : { toolResult: gate.value }),
      });

      return {
        role: 'tool',
        tool_call_id: call.id,
        content: refused
          ? `Refused: ${gate.reason}`
          : JSON.stringify(gate.value),
      };
    }

    this.deps.eventHandler?.({
      type: 'tool_call',
      nodeName: this.node.name,
      toolName: call.name,
      toolArgs: args,
      toolCallId: call.id,
      startedAt,
    });

    let outcome: SeamOutcome;
    try {
      if (parsed.error) throw parsed.error;
      outcome = {
        ok: true,
        value: await this.executeTool(signal, call.name, args, scopedExecutor),
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      outcome = { ok: false, error: { name: error.name, message: error.message } };
    }

    // The other half of the seam, consulted whether the tool returned or threw —
    // which is what `when: 'always'` means in the SEAMS table. A middleware that
    // truncates a large result and one that turns a failure into a canned answer
    // are the same hook seen from two sides.
    const settled = await this.afterToolCall(signal, call, outcome);

    if (settled.action === 'fail') {
      throw new ToolError(
        `"${call.name}" was refused by middleware "${settled.by}": ${settled.reason}`,
      );
    }
    if (settled.action === 'replace') {
      this.warn(
        `"${settled.by}" supplied a result for "${call.name}". The tool did not ` +
          `produce this.`,
      );
      outcome = { ok: true, value: settled.value };
    }

    if (outcome.ok) {
      this.deps.eventHandler?.({
        type: 'tool_result',
        nodeName: this.node.name,
        toolName: call.name,
        toolResult: outcome.value,
        toolCallId: call.id,
        duration: Date.now() - startedAt,
      });

      return {
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(outcome.value),
      };
    }

    this.deps.eventHandler?.({
      type: 'tool_result',
      nodeName: this.node.name,
      toolName: call.name,
      toolCallId: call.id,
      duration: Date.now() - startedAt,
      error: new Error(outcome.error.message),
    });

    return {
      role: 'tool',
      tool_call_id: call.id,
      content: `Error: ${outcome.error.message}`,
    };
  }

  /**
   * Ask the chain what to make of a tool call that has finished.
   *
   * `retry` is not admitted here and `seams.ts` says why: by the time this runs,
   * the assistant message that asked for the call is already in `messages`, so
   * re-issuing it is not re-entering a clean state.
   */
  private async afterToolCall(
    signal: AbortSignal | undefined,
    call: ToolCall,
    outcome: SeamOutcome,
  ): Promise<ChainVerdict> {
    const chain = this.deps.middleware;
    if (!chain?.has('toolCall')) return { action: 'pass' };

    return chain.consult(
      'toolCall',
      {
        subject: {
          nodeName: this.node.name,
          nodeType: 'AgentNode',
          toolName: call.name,
          toolCallId: call.id,
        },
        outcome,
        attempt: 1,
        maxAttempts: 1,
        allowRetry: false,
      },
      signal,
      this.deps.eventHandler,
    );
  }

  /**
   * Ask the middleware chain what should happen to a tool call.
   *
   * Returns `proceed` whenever nothing is installed or nothing subscribes, so
   * the caller has one shape to handle and the no-middleware path never touches
   * the chain — which matters here more than at `nodeError`, because this runs
   * on every tool call of every round rather than on a failure.
   */
  private async beforeToolCall(
    signal: AbortSignal | undefined,
    call: ToolCall,
    args: Record<string, unknown>,
  ): Promise<ChainBefore> {
    const chain = this.deps.middleware;
    if (!chain?.hasBefore('toolCall')) return { action: 'proceed' };

    return chain.consultBefore(
      'toolCall',
      {
        nodeName: this.node.name,
        nodeType: 'AgentNode',
        toolName: call.name,
        toolCallId: call.id,
      },
      args,
      signal,
      this.deps.eventHandler,
    );
  }

  private async executeTool(
    signal: AbortSignal | undefined,
    toolName: string,
    args: Record<string, unknown>,
    scopedExecutor: Executor | undefined,
  ): Promise<Record<string, unknown>> {
    const registry = this.deps.toolRegistry;
    if (!registry) {
      throw new ToolError(`"${toolName}": no tool registry configured`);
    }

    const tool = registry.lookup(toolName);
    if (!tool) {
      throw new ToolError(`"${toolName}" not found in registry`);
    }

    const result = await invokeTool(
      signal,
      tool,
      args,
      scopedExecutor ?? this.deps.toolExecutor,
    );
    return result.output;
  }

  private getProvider(): Provider {
    this.provider ??= providerFor(this.llmConfig, this.deps);
    return this.provider;
  }

  private warn(message: string): void {
    this.deps.eventHandler?.({
      type: 'warning',
      nodeName: this.node.name,
      nodeType: this.node.componentType,
      message,
    });
  }
}

export interface ModelCallContext {
  nodeName: string;
  nodeType?: string;
  eventHandler?: EventHandler;
  allowStream?: boolean;
  turn?: TurnCounter;
  /**
   * The chain, for the `modelCall` seam.
   *
   * Threaded to this function rather than consulted by its callers because this
   * is the one place a model call goes out: an `AgentNode`'s round, an
   * `LlmNode`'s single call, and every retry of either. A seam consulted by the
   * callers instead would have to be added to each of them, and missed by the
   * next one.
   */
  middleware?: MiddlewareChain;
}

/** How many times one model call may be re-issued at a middleware's request. */
const MAX_MODEL_ATTEMPTS = 3;

/**
 * Make one model call, with the `modelCall` seam around it.
 *
 * The seam admits `retry` where `toolCall` does not, and the difference is what
 * has already been said. A failed tool call has an assistant message in
 * `messages` asking for it, so re-issuing is not re-entering a clean state; a
 * failed model call has changed nothing, so it is. That makes this the seam a
 * 429 policy hangs off, which is the most asked-for middleware there is.
 *
 * Attempts are bounded here rather than by the chain, for `maxNodeAttempts`'
 * reason: a ceiling a middleware cannot raise is the only kind that bounds a
 * middleware. A refused retry is reported as a warning and the outcome stands.
 */
export async function completeChat(
  provider: Provider,
  signal: AbortSignal | undefined,
  request: ChatRequest,
  ctx: ModelCallContext,
): Promise<ChatResponse> {
  const chain = ctx.middleware;
  const subject = { nodeName: ctx.nodeName, nodeType: ctx.nodeType };
  let current = request;

  if (chain?.hasBefore('modelCall')) {
    const gate = await chain.consultBefore(
      'modelCall',
      subject,
      current as unknown as Record<string, unknown>,
      signal,
      ctx.eventHandler,
    );

    if (gate.action === 'reject') {
      throw new LLMError(
        `"${gate.by}" refused the model call for "${ctx.nodeName}": ${gate.reason}`,
      );
    }
    if (gate.action === 'replace') {
      // A cache hit, and the reason `replace` is admitted before the call at
      // all: the answer is supplied and nothing is sent.
      warnOf(ctx, `"${gate.by}" answered for "${ctx.nodeName}" without calling the model.`);
      return readChatResponse(gate.value, `middleware "${gate.by}"`);
    }
    if (gate.action === 'modify') {
      current = readChatRequest(current, gate.input, `middleware`);
    }
  }

  for (let attempt = 1; ; attempt++) {
    let outcome: SeamOutcome;
    try {
      outcome = { ok: true, value: await sendChat(provider, signal, current, ctx) };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      outcome = { ok: false, error: { name: error.name, message: error.message } };
    }

    if (!chain?.has('modelCall')) {
      return settleChat(outcome);
    }

    const verdict = await chain.consult(
      'modelCall',
      {
        subject,
        outcome,
        attempt,
        maxAttempts: MAX_MODEL_ATTEMPTS,
        allowRetry: attempt < MAX_MODEL_ATTEMPTS,
      },
      signal,
      ctx.eventHandler,
    );

    if (verdict.action === 'retry') {
      warnOf(
        ctx,
        `"${verdict.by}" is retrying the model call for "${ctx.nodeName}" ` +
          `(attempt ${attempt} of ${MAX_MODEL_ATTEMPTS})` +
          `${verdict.delayMs > 0 ? `, in ${verdict.delayMs}ms` : ''}.`,
      );
      if (verdict.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, verdict.delayMs));
      }
      continue;
    }
    if (verdict.action === 'replace') {
      warnOf(ctx, `"${verdict.by}" supplied an answer for "${ctx.nodeName}".`);
      return readChatResponse(verdict.value, `middleware "${verdict.by}"`);
    }
    if (verdict.action === 'fail') {
      throw new LLMError(
        `the model call for "${ctx.nodeName}" was ended by middleware ` +
          `"${verdict.by}": ${verdict.reason}`,
      );
    }

    return settleChat(outcome);
  }
}

/** The outcome as the caller sees it: a response, or the error that stands. */
function settleChat(outcome: SeamOutcome): ChatResponse {
  if (outcome.ok) return outcome.value as ChatResponse;
  throw new LLMError(outcome.error.message);
}

function warnOf(ctx: ModelCallContext, message: string): void {
  ctx.eventHandler?.({ type: 'warning', nodeName: ctx.nodeName, message });
}

/** The call itself, streamed or buffered, unchanged by the seam around it. */
async function sendChat(
  provider: Provider,
  signal: AbortSignal | undefined,
  request: ChatRequest,
  ctx: ModelCallContext,
): Promise<ChatResponse> {
  if (!provider.chatCompletionStream || ctx.allowStream === false) {
    return provider.chatCompletion(signal, request);
  }

  const turn = ctx.turn ?? { emitted: 0 };
  try {
    return await collectStream(
      provider.chatCompletionStream(signal, request),
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
        message: abandonedStreamWarning(ctx.nodeName, turn.emitted, err),
      });
    }
    throw err;
  }
}

export async function collectStream(
  chunks: AsyncIterable<ChatChunk>,
  onContent?: (text: string) => void,
): Promise<ChatResponse> {
  let content = '';
  let finishReason = '';
  const callsByIndex = new Map<number, ToolCall>();

  for await (const chunk of chunks) {
    if (chunk.content) {
      content += chunk.content;
      onContent?.(chunk.content);
    }

    for (const delta of chunk.tool_calls ?? []) {
      const call = callsByIndex.get(delta.index) ?? blankToolCall();
      if (delta.id) call.id = delta.id;
      if (delta.name) call.name = delta.name;
      if (delta.arguments) call.arguments += delta.arguments;
      callsByIndex.set(delta.index, call);
    }

    if (chunk.finish_reason) finishReason = chunk.finish_reason;
  }

  const response: ChatResponse = { content, finish_reason: finishReason };
  if (callsByIndex.size > 0) {
    response.tool_calls = inCallOrder(callsByIndex);
  }
  return response;
}

export function substituteTemplate(template: string, state: State): string {
  let result = template;
  for (const key of state.keys()) {
    result = result.replaceAll(`{{${key}}}`, state.getString(key) ?? '');
  }
  return result;
}

export function buildToolDefinitions(
  tools: ToolSpec[] | undefined,
  registry: Registry | undefined,
  warn: (message: string) => void,
): ToolDefinition[] {
  return (tools ?? []).map((tool) => {
    const known = registry?.lookup(tool.name);
    const described = tool.description ?? '';

    if (described && known?.description && described !== known.description) {
      warn(conflictingDescriptionWarning(tool.name, described, known.origin));
    }

    return {
      name: tool.name,
      description: described || known?.description || '',
      parameters: toolParameters(tool, known?.inputSchema),
    };
  });
}

export function buildToolSchema(tool: ToolSpec): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  for (const input of tool.inputs ?? []) {
    const name = propertyTitle(input);
    if (!name) continue;

    properties[name] = withoutTitle(input.jsonSchema);
    if (input.jsonSchema.default === undefined) required.push(name);
  }

  return { type: 'object', properties, required };
}

function toolParameters(
  tool: ToolSpec,
  knownSchema: JsonSchema | undefined,
): JsonSchema {
  const specDeclaresInputs = Boolean(tool.inputs && tool.inputs.length > 0);
  if (specDeclaresInputs) return buildToolSchema(tool);
  return knownSchema ?? buildToolSchema(tool);
}

function withoutTitle(schema: JsonSchema): JsonSchema {
  const { title: _title, ...rest } = schema;
  return rest;
}

function withDefaults(
  args: Record<string, unknown>,
  tools: ToolSpec[] | undefined,
  calledTool: string,
): Record<string, unknown> {
  const spec = tools?.find((tool) => tool.name === calledTool);
  if (!spec?.inputs) return args;

  let filled: Record<string, unknown> | undefined;
  for (const input of spec.inputs) {
    const name = propertyTitle(input);
    if (!name || input.jsonSchema.default === undefined) continue;
    if (Object.hasOwn(args, name)) continue;

    filled ??= { ...args };
    filled[name] = input.jsonSchema.default;
  }
  return filled ?? args;
}

function parseToolArguments(call: ToolCall): {
  args: Record<string, unknown>;
  error?: ToolError;
} {
  const raw = typeof call.arguments === 'string' ? call.arguments : '';

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return {
      args: {},
      error: new ToolError(unparseableArgumentsMessage(call.name, raw), {
        cause: err,
      }),
    };
  }

  if (!isPlainObject(value)) {
    return {
      args: {},
      error: new ToolError(wrongArgumentsShapeMessage(call.name, value)),
    };
  }

  return { args: value };
}

function chatHistoryOf(input: State): Message[] {
  const history = input.get(CHAT_HISTORY_KEY);
  if (!Array.isArray(history)) return [];

  return (history as Array<{ role: string; content: string }>).map((entry) => ({
    role: entry.role as Message['role'],
    content: entry.content,
  }));
}

function inputWithoutHistory(input: State): Record<string, unknown> {
  const data = input.toData();
  delete data[CHAT_HISTORY_KEY];
  return data;
}

function answerFields(answer: string): Record<string, unknown> {
  const output: Record<string, unknown> = { result: answer };

  const parsed = parseJson(answer);
  if (parsed !== undefined) Object.assign(output, parsed);

  return output;
}

function rejectionState(rejected: Rejection): State {
  return new State({
    result: rejected.replacement ?? rejected.reason,
    transform_status: 'rejected',
    transform_reason: rejected.reason,
    transform_name: rejected.transform,
    transform_phase: rejected.phase,
  });
}

function blankToolCall(): ToolCall {
  return { id: '', name: '', arguments: '' };
}

function inCallOrder(callsByIndex: Map<number, ToolCall>): ToolCall[] {
  return [...callsByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abandonedStreamWarning(
  nodeName: string,
  emitted: number,
  err: unknown,
): string {
  const cause = err instanceof Error ? err.message : String(err);
  return (
    `"${nodeName}": the model stream failed after ${emitted} token ` +
    `deltas had already been sent. Those deltas are not this node's ` +
    `output — nothing was produced. Discard the partial text rather ` +
    `than showing it as an answer. Cause: ${cause}`
  );
}

function conflictingDescriptionWarning(
  toolName: string,
  described: string,
  origin: string | undefined,
): string {
  return (
    `tool "${toolName}" is described one way in the flow and another by ` +
    `${origin ?? 'the registry'}. The model is told the flow's: ` +
    `"${described}".`
  );
}

function unparseableArgumentsMessage(toolName: string, raw: string): string {
  const got =
    raw.trim() === ''
      ? 'nothing at all'
      : raw.slice(0, MAX_REPORTED_ARGUMENT_LENGTH);
  return (
    `"${toolName}" was called with arguments that are not JSON. ` +
    `Send a JSON object of named arguments. Got: ${got}`
  );
}

function wrongArgumentsShapeMessage(toolName: string, value: unknown): string {
  const got =
    value === null
      ? 'null'
      : Array.isArray(value)
        ? 'an array'
        : `a ${typeof value}`;
  return (
    `"${toolName}" was called with ${got}. ` +
    `Send a JSON object of named arguments.`
  );
}
