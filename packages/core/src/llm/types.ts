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

/** Provider is the interface for LLM providers. */
export interface Provider {
  chatCompletion(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): Promise<ChatResponse>;
}
