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
import { generationParams, providerFor } from '../llm/provider.js';
import { TransformChain } from '../plugin/transform.js';
import { RunError, ToolError } from '../errors.js';

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
    const args = withDefaults(parsed.args, this.agent.tools, call.name);
    const startedAt = Date.now();

    this.deps.eventHandler?.({
      type: 'tool_call',
      nodeName: this.node.name,
      toolName: call.name,
      toolArgs: args,
      toolCallId: call.id,
      startedAt,
    });

    try {
      if (parsed.error) throw parsed.error;

      const output = await this.executeTool(
        signal,
        call.name,
        args,
        scopedExecutor,
      );
      const content = JSON.stringify(output);

      this.deps.eventHandler?.({
        type: 'tool_result',
        nodeName: this.node.name,
        toolName: call.name,
        toolResult: output,
        toolCallId: call.id,
        duration: Date.now() - startedAt,
      });

      return { role: 'tool', tool_call_id: call.id, content };
    } catch (err) {
      this.deps.eventHandler?.({
        type: 'tool_result',
        nodeName: this.node.name,
        toolName: call.name,
        toolCallId: call.id,
        duration: Date.now() - startedAt,
        error: err instanceof Error ? err : new Error(String(err)),
      });

      return { role: 'tool', tool_call_id: call.id, content: `Error: ${err}` };
    }
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
  eventHandler?: EventHandler;
  allowStream?: boolean;
  turn?: TurnCounter;
}

export async function completeChat(
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
