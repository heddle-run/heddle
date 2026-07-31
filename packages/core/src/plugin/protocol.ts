import { PluginError } from '../errors.js';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Message,
  ModelRequest,
  Role,
  ToolCall,
  ToolCallDelta,
  ToolDefinition,
} from '../llm/types.js';
import type { LogLevel } from '../runner/events.js';
import {
  SEAMS,
  type AfterAction,
  type BeforeAction,
  type Seam,
} from './seams.js';
import type { WireFrame } from './types.js';

export const PROTOCOL_VERSION = 1;

const UNVERSIONED = 1;

export interface HostMethods {
  execute: ExecuteParams;
  apply: ApplyParams;
  callTool: CallToolParams;
  chat: ChatParams;
  after: AfterParams;
  before: BeforeParams;
  encode: EncodeParams;
  finishEncode: FinishEncodeParams;
  listTools: ListToolsParams;
}

export type HostMethod = keyof HostMethods;

export interface HostLifecycleMethods {
  init: InitParams;
  shutdown: ShutdownParams;
  cancel: CancelParams;
}

export interface HostVerbs extends HostMethods, HostLifecycleMethods {}

export type HostVerb = keyof HostVerbs;

export interface PluginMethods {
  runTool: RunToolParams;
  emitEvent: EmitEventParams;
  log: LogParams;
  callModel: CallModelParams;
}

export type PluginMethod = keyof PluginMethods;

export type PluginCapability = PluginMethod;

export interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: number | string;
  result?: unknown;
  error?: { name?: string; message: string };
}

export interface RpcPartial {
  id: number | string;
  partial: unknown;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcPartial;

export interface InitParams extends Record<string, unknown> {
  protocol: number;
  capabilities: PluginCapability[];
  seams?: Record<string, AfterAction[]>;
  events: number;
}

export interface InitResult {
  protocol: number;
}

export type ShutdownParams = Record<string, never>;

/**
 * Params for `listTools`: none.
 *
 * The only work verb heddle sends that carries nothing, and the emptiness is the
 * point. Every other one names the component it is about, because a plugin can
 * provide several and heddle has to say which it is talking to. This is
 * addressed to the plugin itself — *what have you got* — so there is nothing to
 * name. Sent exactly once, at load, before any flow has been compiled against
 * the answer.
 */
export type ListToolsParams = Record<string, never>;

export interface CancelParams extends Record<string, unknown> {
  call: number | string;
}

export interface ExecuteParams extends Record<string, unknown> {
  componentType: string;
  node: Record<string, unknown>;
  input: Record<string, unknown>;
  workspace?: string;
  workspaceUnavailable?: 'confined';
}

export interface CallToolParams extends Record<string, unknown> {
  componentType: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ChatParams extends Record<string, unknown> {
  componentType: string;
  config: Record<string, unknown>;
  request: ChatRequest;
  stream: boolean;
}

export interface EncodeParams extends Record<string, unknown> {
  componentType: string;
  runId: string;
  event: Record<string, unknown>;
}

export interface FinishEncodeParams extends Record<string, unknown> {
  componentType: string;
  runId: string;
}

export interface ApplyParams extends Record<string, unknown> {
  componentType: string;
  component: Record<string, unknown>;
  phase: 'pre' | 'post';
  messages: unknown[];
}

export interface SeamSubject {
  nodeName?: string;
  nodeType?: string;
  /** For `toolCall`: which tool, and which of the model's calls asked for it. */
  toolName?: string;
  toolCallId?: string;
}

export interface AfterParams extends Record<string, unknown> {
  seam: Seam;
  componentType: string;
  component: Record<string, unknown>;
  subject: SeamSubject;
  outcome:
    | { ok: true; value: unknown }
    | { ok: false; error: { name: string; message: string } };
  attempt: number;
  maxAttempts: number;
}

export type AfterVerdict =
  | { action: 'pass' }
  | { action: 'replace'; value: Record<string, unknown> }
  | { action: 'retry'; delayMs?: number }
  | { action: 'fail'; reason: string };

/**
 * Params for `before`: a call site is about to do something, and is asking.
 *
 * The mirror of {@link AfterParams}, and the asymmetry is the whole difference
 * between the halves. `after` reports an `outcome` — the work is done and a
 * middleware is deciding what to make of it. `before` carries the `input` the
 * call site is about to use, because the work has not happened and the decision
 * is whether, and with what, it should.
 *
 * There is no `attempt` here. Attempts are a property of a node's arrival, which
 * `nodeError` counts; a tool call is made once per model request and re-issuing
 * one is not re-entering a clean state — see the note on `toolCall.after` in
 * `seams.ts`.
 */
export interface BeforeParams extends Record<string, unknown> {
  seam: Seam;
  componentType: string;
  component: Record<string, unknown>;
  subject: SeamSubject;
  /** What the call site is about to be given. For `toolCall`, the arguments. */
  input: Record<string, unknown>;
}

/**
 * What a middleware may say before a call site acts.
 *
 * `replace` and `reject` both mean the work does not happen, and they are
 * different claims about why. `replace` supplies a result and the call site
 * carries on as though the work had produced it. `reject` says it must not
 * happen at all, and the reason is reported to whoever asked — for a tool call,
 * to the model, which is what makes an approval gate expressible.
 */
export type BeforeVerdict =
  | { action: 'proceed' }
  | { action: 'modify'; input: Record<string, unknown> }
  | { action: 'replace'; value: Record<string, unknown> }
  | { action: 'reject'; reason: string };

interface InFlight extends Record<string, unknown> {
  call: number | string;
}

export interface RunToolParams extends InFlight {
  name: string;
  input: Record<string, unknown>;
}

export interface EmitEventParams extends InFlight {
  name: string;
  data?: unknown;
}

export interface LogParams extends InFlight {
  level: LogLevel;
  message: string;
}

export interface CallModelParams extends InFlight, ModelRequest {}

const SERVED: Record<PluginMethod, true> = {
  runTool: true,
  emitEvent: true,
  log: true,
  callModel: true,
};

export const PLUGIN_METHODS = Object.keys(SERVED) as PluginMethod[];

export const PLUGIN_CAPABILITIES: PluginCapability[] = PLUGIN_METHODS;

const ROLES: Record<Role, true> = {
  system: true,
  user: true,
  assistant: true,
  tool: true,
};

const LEVELS: Record<LogLevel, true> = {
  debug: true,
  info: true,
  warn: true,
  error: true,
};

export const LOG_LEVELS = Object.keys(LEVELS) as LogLevel[];

const NEWLINE = /[\r\n]/;

export function hostRequest<V extends HostVerb>(
  id: number,
  method: V,
  params: HostVerbs[V],
): RpcRequest {
  return { id, method, params };
}

export function spokenProtocol(result: unknown): number {
  if (!isObject(result)) return UNVERSIONED;

  const { protocol } = result;
  return typeof protocol === 'number' && Number.isInteger(protocol)
    ? protocol
    : UNVERSIONED;
}

export function isPluginMethod(method: string): method is PluginMethod {
  return Object.hasOwn(SERVED, method);
}

export function isPluginCapability(value: string): value is PluginCapability {
  return isPluginMethod(value);
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && Object.hasOwn(LEVELS, value);
}

export function isObject(message: unknown): message is Record<string, unknown> {
  return (
    typeof message === 'object' && message !== null && !Array.isArray(message)
  );
}

export function isRequest(message: unknown): message is RpcRequest {
  return isObject(message) && typeof message.method === 'string';
}

export function isPartial(message: unknown): message is RpcPartial {
  return (
    isObject(message) &&
    typeof message.method !== 'string' &&
    Object.hasOwn(message, 'partial')
  );
}

export function readToolResult(
  raw: unknown,
  where: string,
): { output: Record<string, unknown>; stderr: string } {
  if (!isObject(raw)) {
    throw new PluginError(
      `${where} returned ${typeName(raw)}, expected { output }`,
    );
  }

  const { output, stderr } = raw;
  if (!isObject(output)) {
    throw new PluginError(
      `${where} returned no "output" object. A tool's result becomes a message the ` +
        `model reads, so it has to be a JSON object of named values — wrap a bare ` +
        `value as { result: … }.`,
    );
  }

  return { output, stderr: typeof stderr === 'string' ? stderr : '' };
}

export function readChatResponse(raw: unknown, where: string): ChatResponse {
  if (!isObject(raw)) {
    throw new PluginError(
      `${where} returned ${typeName(raw)}, expected { content, finish_reason }`,
    );
  }
  if (typeof raw.content !== 'string') {
    throw new PluginError(
      `${where} returned no "content" string. A model answer with nothing in it is ` +
        `still written as "" — an absent content is a provider that failed without ` +
        `saying so.`,
    );
  }

  const response: ChatResponse = {
    content: raw.content,
    finish_reason:
      typeof raw.finish_reason === 'string' ? raw.finish_reason : '',
  };

  const calls = readToolCalls(raw.tool_calls, where);
  if (calls) response.tool_calls = calls;

  return response;
}

export function readChatChunk(raw: unknown, where: string): ChatChunk {
  if (!isObject(raw)) {
    throw new PluginError(
      `${where} sent ${typeName(raw)} as a stream chunk, expected an object with ` +
        `any of "content", "tool_calls" or "finish_reason".`,
    );
  }

  const chunk: ChatChunk = {};

  if (isSet(raw.content)) {
    if (typeof raw.content !== 'string') {
      throw new PluginError(
        `${where} sent a chunk whose "content" is ${typeName(raw.content)}, not a ` +
          `string. Chunks are concatenated, so anything else corrupts the answer.`,
      );
    }
    chunk.content = raw.content;
  }

  if (isSet(raw.finish_reason)) {
    if (typeof raw.finish_reason !== 'string') {
      throw new PluginError(
        `${where} sent a chunk whose "finish_reason" is ${typeName(raw.finish_reason)}, ` +
          `not a string.`,
      );
    }
    chunk.finish_reason = raw.finish_reason;
  }

  if (isSet(raw.tool_calls)) {
    chunk.tool_calls = readToolCallDeltas(raw.tool_calls, where);
  }

  return chunk;
}

export function readWireFrames(raw: unknown, where: string): WireFrame[] {
  if (!Array.isArray(raw)) {
    throw new PluginError(
      `${where} returned ${typeName(raw)}, expected an array of frames. An encoder ` +
        `with nothing to say about an event returns [].`,
    );
  }

  return raw.map((entry, index) => readWireFrame(entry, index + 1, where));
}

export function readAfterVerdict(
  seam: Seam,
  raw: unknown,
  where: string,
): AfterVerdict {
  if (!isObject(raw)) {
    throw new PluginError(
      `${where}: returned ${typeName(raw)}, expected { action }`,
    );
  }

  const admitted = SEAMS[seam].after;
  const { action } = raw;
  if (
    typeof action !== 'string' ||
    !admitted.includes(action as AfterAction)
  ) {
    throw new PluginError(
      `${where}: returned action ${JSON.stringify(action)}. The "${seam}" seam ` +
        `admits: ${admitted.join(', ')}.`,
    );
  }

  switch (action as AfterAction) {
    case 'pass':
      return { action: 'pass' };
    case 'replace':
      return { action: 'replace', value: readReplacement(raw.value, where) };
    case 'retry':
      return readRetry(raw.delayMs, where);
    case 'fail':
      return { action: 'fail', reason: readFailReason(raw.reason, where) };
  }
}

/**
 * Read what a middleware said before a call site acted.
 *
 * `readAfterVerdict`'s shape, checked against the other half of the same table,
 * so a seam that admits `modify` and one that does not are distinguished by data
 * rather than by whoever wrote the call site.
 */
export function readBeforeVerdict(
  seam: Seam,
  raw: unknown,
  where: string,
): BeforeVerdict {
  if (!isObject(raw)) {
    throw new PluginError(
      `${where}: returned ${typeName(raw)}, expected { action }`,
    );
  }

  const admitted = SEAMS[seam].before;
  const { action } = raw;
  if (
    typeof action !== 'string' ||
    !admitted.includes(action as BeforeAction)
  ) {
    throw new PluginError(
      `${where}: returned action ${JSON.stringify(action)}. The "before" half of ` +
        `"${seam}" admits: ${admitted.join(', ')}.`,
    );
  }

  switch (action as BeforeAction) {
    case 'proceed':
      return { action: 'proceed' };
    case 'modify':
      // The same check `replace` gets, for the same reason: this becomes a
      // tool's arguments, and a non-object would surface as the tool failing.
      return { action: 'modify', input: readReplacement(raw.input, where) };
    case 'replace':
      return { action: 'replace', value: readReplacement(raw.value, where) };
    case 'reject':
      return { action: 'reject', reason: readFailReason(raw.reason, where) };
  }
}

/**
 * Read a request a middleware modified, against the one it was given.
 *
 * The `modelCall` seam's `modify` is the only verdict in the system that hands
 * back something heddle then *sends somewhere*, so it gets the strictest
 * treatment: fields are taken one at a time and type-checked, and anything the
 * middleware did not supply keeps the value it was shown. A returned object is
 * therefore an edit rather than a replacement, which is what an author writing
 * `{ ...input, temperature: 0 }` already assumes.
 *
 * `messages` is checked structurally because it is the field worth corrupting —
 * a provider rejects a malformed array with an error naming the model, several
 * frames from the middleware that caused it.
 */
export function readChatRequest(
  original: ChatRequest,
  raw: unknown,
  where: string,
): ChatRequest {
  if (!isObject(raw)) {
    throw new PluginError(
      `${where} returned ${typeName(raw)} as a modified model request, expected ` +
        `an object.`,
    );
  }

  const edited: ChatRequest = { ...original };

  if (raw.messages !== undefined) {
    if (!Array.isArray(raw.messages)) {
      throw new PluginError(
        `${where} returned a "messages" that is not an array. A model request ` +
          `carries an ordered conversation, and anything else reaches the provider ` +
          `as a malformed body.`,
      );
    }
    edited.messages = raw.messages.map((message, i) =>
      readEditedMessage(message, `${where}: message ${i + 1}`),
    );
  }

  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !raw.model) {
      throw new PluginError(`${where} returned a "model" that is not a name.`);
    }
    edited.model = raw.model;
  }

  for (const key of ['temperature', 'maxTokens', 'topP'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) {
      throw new PluginError(
        `${where} returned a "${key}" that is not a number. These are sent to the ` +
          `model as written.`,
      );
    }
    edited[key] = raw[key];
  }

  return edited;
}

/**
 * One message out of a middleware's edited request.
 *
 * Deliberately not `readMessage` below, which serves `callModel` and names it in
 * every error. The provenance differs and so should the attribution: a malformed
 * message here came from a middleware the operator installed, not from a plugin
 * composing a request, and an error blaming the wrong one sends somebody to the
 * wrong file.
 */
function readEditedMessage(raw: unknown, where: string): Message {
  if (!isObject(raw)) {
    throw new PluginError(`${where} is ${typeName(raw)}, expected { role, content }`);
  }
  if (typeof raw.role !== 'string' || !Object.hasOwn(ROLES, raw.role)) {
    throw new PluginError(
      `${where} has role ${JSON.stringify(raw.role)}; expected one of ` +
        `${Object.keys(ROLES).join(', ')}.`,
    );
  }
  if (typeof raw.content !== 'string') {
    throw new PluginError(`${where} has no "content" string.`);
  }

  const message: Message = { role: raw.role as Role, content: raw.content };
  if (typeof raw.tool_call_id === 'string') message.tool_call_id = raw.tool_call_id;
  const calls = readToolCalls(raw.tool_calls, where);
  if (calls) message.tool_calls = calls;
  return message;
}

export function readModelRequest(
  params: Record<string, unknown> | undefined,
): ModelRequest {
  const raw = params ?? {};

  if (!Array.isArray(raw.messages) || raw.messages.length === 0) {
    throw new PluginError(
      'callModel needs a non-empty "messages" array: the conversation to send. A ' +
        'call with nothing to say has no answer to return.',
    );
  }

  const request: ModelRequest = { messages: raw.messages.map(readMessage) };

  if (raw.tools !== undefined) {
    request.tools = readToolDefinitions(raw.tools);
  }

  const temperature = readNumber(raw, 'temperature');
  if (temperature !== undefined) request.temperature = temperature;

  const maxTokens = readNumber(raw, 'maxTokens');
  if (maxTokens !== undefined) request.maxTokens = maxTokens;

  const topP = readNumber(raw, 'topP');
  if (topP !== undefined) request.topP = topP;

  if (raw.responseFormat !== undefined) {
    request.responseFormat = readResponseFormat(raw.responseFormat);
  }

  return request;
}

export function encode(message: RpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export class LineDecoder {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    return lines.filter((line) => line.trim().length > 0);
  }

  flush(): string | undefined {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest.length > 0 ? rest : undefined;
  }
}

function readToolCalls(raw: unknown, where: string): ToolCall[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new PluginError(
      `${where} returned a "tool_calls" that is not an array`,
    );
  }

  return raw.map((call, index) => {
    if (!isToolCall(call)) {
      throw new PluginError(
        `${where}: tool_calls[${index}] needs a string "id", "name" and "arguments". ` +
          `"arguments" is the JSON the model wrote, as text — not the parsed object.`,
      );
    }
    return { id: call.id, name: call.name, arguments: call.arguments };
  });
}

function readToolCallDeltas(raw: unknown, where: string): ToolCallDelta[] {
  if (!Array.isArray(raw)) {
    throw new PluginError(
      `${where} sent a chunk whose "tool_calls" is not an array`,
    );
  }

  return raw.map((call, index): ToolCallDelta => {
    if (!isObject(call) || typeof call.index !== 'number') {
      throw new PluginError(
        `${where}: stream chunk tool_calls[${index}] needs a numeric "index". Fragments ` +
          `of one call are joined by position — only the first carries "id" and ` +
          `"name" — so a fragment with no index cannot be matched to its call.`,
      );
    }

    const delta: ToolCallDelta = { index: call.index };
    if (typeof call.id === 'string') delta.id = call.id;
    if (typeof call.name === 'string') delta.name = call.name;
    if (typeof call.arguments === 'string') delta.arguments = call.arguments;
    return delta;
  });
}

function readWireFrame(
  entry: unknown,
  position: number,
  where: string,
): WireFrame {
  if (!isObject(entry)) {
    throw new PluginError(
      `${where} returned ${typeName(entry)} as frame ${position}, expected ` +
        `{ data } with an optional "event" name.`,
    );
  }
  if (!Object.hasOwn(entry, 'data')) {
    throw new PluginError(
      `${where} returned a frame ${position} with no "data". A frame carries the ` +
        `payload a client parses; a frame naming an event and carrying nothing is ` +
        `a frame that says nothing.`,
    );
  }

  const frame: WireFrame = { data: entry.data };
  if (entry.event !== undefined) {
    frame.event = readEventName(entry.event, position, where);
  }
  return frame;
}

function readEventName(
  event: unknown,
  position: number,
  where: string,
): string {
  if (typeof event !== 'string') {
    throw new PluginError(
      `${where} returned a frame ${position} whose "event" is ` +
        `${typeName(event)}, expected a string. Omit it for a frame that ` +
        `carries only data, which is what a protocol putting its own type inside ` +
        `the payload wants.`,
    );
  }
  if (NEWLINE.test(event)) {
    throw new PluginError(
      `${where} returned a frame ${position} whose "event" contains a newline. The ` +
        `event name is the one part of a frame written without escaping, so a ` +
        `newline in it would end the frame and let the rest be read as another.`,
    );
  }
  return event;
}

function readReplacement(
  value: unknown,
  where: string,
): Record<string, unknown> {
  if (!isObject(value)) {
    throw new PluginError(
      `${where}: returned "replace" without a "value" object. A replaced node ` +
        `produces a state, so the value is the output object that node would ` +
        `have returned.`,
    );
  }
  return value;
}

function readRetry(delayMs: unknown, where: string): AfterVerdict {
  if (delayMs === undefined) return { action: 'retry' };

  if (typeof delayMs !== 'number' || !Number.isFinite(delayMs)) {
    throw new PluginError(
      `${where}: returned "retry" with a delayMs of ${JSON.stringify(delayMs)}, ` +
        `which is not a number of milliseconds.`,
    );
  }
  return { action: 'retry', delayMs };
}

function readFailReason(reason: unknown, where: string): string {
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new PluginError(
      `${where}: returned "fail" without a "reason". The reason replaces the ` +
        `error the run would otherwise have reported, so an empty one loses the ` +
        `only diagnosis anybody had.`,
    );
  }
  return reason;
}

function readMessage(raw: unknown, index: number): Message {
  if (!isObject(raw)) {
    throw new PluginError(
      `callModel: ${at(index)} is ${typeName(raw)}, not a message object`,
    );
  }

  const role = readRole(raw.role, index);
  const content = raw.content;
  if (typeof content !== 'string') {
    throw new PluginError(
      `callModel: ${at(index)} has no "content" string. A message with nothing to ` +
        `say is still written as "".`,
    );
  }

  const message: Message = { role, content };

  if (role === 'tool') {
    message.tool_call_id = readToolCallId(raw.tool_call_id, index);
  }
  if (raw.tool_calls !== undefined) {
    message.tool_calls = readMessageToolCalls(raw.tool_calls, index);
  }

  return message;
}

function readRole(role: unknown, index: number): Role {
  if (typeof role !== 'string' || !Object.hasOwn(ROLES, role)) {
    throw new PluginError(
      `callModel: ${at(index)} has role ${JSON.stringify(role)}; expected one of ` +
        `${Object.keys(ROLES).join(', ')}.`,
    );
  }
  return role as Role;
}

function readToolCallId(toolCallId: unknown, index: number): string {
  if (typeof toolCallId !== 'string') {
    throw new PluginError(
      `callModel: ${at(index)} is a tool message with no "tool_call_id". A tool ` +
        `result answers a specific call, and the model matches them by that id.`,
    );
  }
  return toolCallId;
}

function readMessageToolCalls(raw: unknown, index: number): ToolCall[] {
  if (!Array.isArray(raw)) {
    throw new PluginError(
      `callModel: ${at(index)} has a "tool_calls" that is not an array`,
    );
  }

  return raw.map((call, position) => {
    if (!isToolCall(call)) {
      throw new PluginError(
        `callModel: ${at(index)}.tool_calls[${position}] needs a string "id", "name" and ` +
          `"arguments". "arguments" is the JSON the model wrote, as text — not the ` +
          `parsed object.`,
      );
    }
    return { id: call.id, name: call.name, arguments: call.arguments };
  });
}

function readToolDefinitions(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw)) {
    throw new PluginError('callModel: "tools" is not an array');
  }

  return raw.map((tool, index): ToolDefinition => {
    if (
      !isObject(tool) ||
      typeof tool.name !== 'string' ||
      !isObject(tool.parameters)
    ) {
      throw new PluginError(
        `callModel: tools[${index}] needs a string "name" and a "parameters" JSON ` +
          `Schema object. Describing a tool to the model does not run it — that is ` +
          `runTool, and it is granted separately.`,
      );
    }
    return {
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.parameters,
    };
  });
}

function readResponseFormat(value: unknown): 'text' | 'json' {
  if (value !== 'text' && value !== 'json') {
    throw new PluginError(
      `callModel: "responseFormat" is ${JSON.stringify(value)}; ` +
        `expected "text" or "json".`,
    );
  }
  return value;
}

function readNumber(
  raw: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = raw[key];
  if (!isSet(value)) return undefined;

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PluginError(
      `callModel: "${key}" is ${JSON.stringify(value)}, which is not a number.`,
    );
  }
  return value;
}

function isToolCall(
  value: unknown,
): value is { id: string; name: string; arguments: string } {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.arguments === 'string'
  );
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function at(index: number): string {
  return `messages[${index}]`;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}
