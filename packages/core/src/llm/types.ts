/** A JSON Schema object. */
export type JsonSchema = Record<string, unknown>;

/** Role represents a message role. */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** Message is a chat message. */
export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** ToolCall represents a tool call from the LLM. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

/** ToolDefinition describes a tool for the LLM. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** ChatRequest is a request to the LLM. */
export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
}

/** ChatResponse is a response from the LLM. */
export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: string;
}

/**
 * A fragment of one tool call, as it arrives mid-stream.
 *
 * `index` is the identity, not `id`. Providers send a tool call in pieces and
 * only the first piece carries `id` and `name` — every piece after it is bare
 * `arguments` text. Position is the only thing present on all of them, and a
 * model calling two tools in one turn interleaves their fragments, so keying
 * anything else would concatenate two argument blobs into one unparseable
 * string.
 *
 * `arguments` is a slice of a JSON document, not a JSON document. It is not
 * parseable until the stream ends; anything that parses it early is reading a
 * truncated object.
 */
export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

/**
 * One increment of a streamed response.
 *
 * Every field is optional because a chunk carries whatever the provider had at
 * that moment: text, tool-call fragments, a terminal `finish_reason`, or a
 * combination. Fields accumulate — `content` appends, `tool_calls` merge by
 * index, `finish_reason` is last-write-wins — and the accumulation of a whole
 * stream is exactly the {@link ChatResponse} the non-streaming call returns.
 *
 * This type is what every future provider implements against, so it says only
 * what all of them can say.
 */
export interface ChatChunk {
  content?: string;
  tool_calls?: ToolCallDelta[];
  finish_reason?: string;
}

/** Provider is the interface for LLM providers. */
export interface Provider {
  chatCompletion(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): Promise<ChatResponse>;

  /**
   * The same call, delivered incrementally.
   *
   * Optional, and deliberately so: making it mandatory would invalidate every
   * provider written against the interface before it existed. A caller checks
   * for it and falls back to {@link chatCompletion}, so a provider that cannot
   * stream is not a provider that cannot be used.
   *
   * Streaming moves when a failure surfaces. `chatCompletion` fails before its
   * caller has shown anyone anything; this can fail after fifty chunks have
   * already been forwarded to a client. Implementations must still throw
   * rather than end the iteration early, so a caller can tell a finished
   * answer from an abandoned one.
   */
  chatCompletionStream?(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): AsyncIterable<ChatChunk>;
}
