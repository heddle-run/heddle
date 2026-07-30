export type JsonSchema = Record<string, unknown>;

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: Role;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export type ResponseFormat = 'text' | 'json';

export interface ChatRequest {
  model: string;
  messages: Message[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  responseFormat?: ResponseFormat;
}

export type ModelRequest = Omit<ChatRequest, 'model'>;

export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  finish_reason: string;
}

export interface ToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  arguments?: string;
}

export interface ChatChunk {
  content?: string;
  tool_calls?: ToolCallDelta[];
  finish_reason?: string;
}

export interface Provider {
  chatCompletion(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): Promise<ChatResponse>;

  chatCompletionStream?(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): AsyncIterable<ChatChunk>;
}
