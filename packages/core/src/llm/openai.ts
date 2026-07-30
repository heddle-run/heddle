import OpenAI from 'openai';
import type {
  ChatChunk,
  ChatRequest,
  ChatResponse,
  Provider,
  ToolCall,
  ToolCallDelta,
} from './types.js';
import { LLMError } from '../errors.js';

interface GenerationParams {
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  response_format?: { type: 'json_object' };
}

export class OpenAIProvider implements Provider {
  private readonly client: OpenAI;

  constructor(options?: {
    apiKey?: string;
    baseURL?: string;
    /**
     * The fetch the SDK uses, so an egress policy can refuse a redirect.
     *
     * A policy is checked once, against the base URL, before any connection is
     * made — so without this the address checked is not the address connected
     * to. See `redirectRefusingFetch` in `provider.ts`.
     */
    fetch?: typeof fetch;
  }) {
    // Cast at the boundary: the SDK types its `fetch` option as its own `Core.Fetch`,
    // which is structurally the global `fetch` with a looser first parameter.
    this.client = new OpenAI(options as ConstructorParameters<typeof OpenAI>[0]);
  }

  async chatCompletion(
    signal: AbortSignal | undefined,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    try {
      const completion = await this.client.chat.completions.create(
        buildRequestBody(request),
        { signal },
      );

      const choice = completion.choices?.[0];
      if (!choice) {
        throw new LLMError('no choices in response');
      }

      return toResponse(choice);
    } catch (err) {
      throw asLLMError(err);
    }
  }

  async *chatCompletionStream(
    signal: AbortSignal | undefined,
    request: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    try {
      const stream = await this.client.chat.completions.create(
        { ...buildRequestBody(request), stream: true },
        { signal },
      );

      let sawChoice = false;
      for await (const part of stream) {
        const choice = part.choices?.[0];
        if (!choice) continue;
        sawChoice = true;

        const chunk = toChunk(choice);
        if (isEmptyChunk(chunk)) continue;
        yield chunk;
      }

      if (signal?.aborted) {
        throw new LLMError('the model stream was aborted before it finished');
      }
      if (!sawChoice) {
        throw new LLMError(
          'the model stream closed without sending any choices',
        );
      }
    } catch (err) {
      throw asLLMError(err);
    }
  }
}

function buildRequestBody(request: ChatRequest) {
  return {
    model: request.model,
    messages: buildMessages(request),
    tools: buildTools(request),
    ...buildGeneration(request),
  };
}

function toResponse(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
): ChatResponse {
  const response: ChatResponse = {
    content: choice.message.content ?? '',
    finish_reason: choice.finish_reason ?? '',
  };

  const toolCalls = choice.message.tool_calls ?? [];
  if (toolCalls.length > 0) {
    response.tool_calls = toolCalls.map(
      (call): ToolCall => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }),
    );
  }

  return response;
}

function toChunk(
  choice: OpenAI.Chat.Completions.ChatCompletionChunk.Choice,
): ChatChunk {
  const chunk: ChatChunk = {};

  if (choice.delta.content) {
    chunk.content = choice.delta.content;
  }

  const toolCalls = choice.delta.tool_calls ?? [];
  if (toolCalls.length > 0) {
    chunk.tool_calls = toolCalls.map(toToolCallDelta);
  }

  if (choice.finish_reason) {
    chunk.finish_reason = choice.finish_reason;
  }

  return chunk;
}

function toToolCallDelta(
  call: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall,
): ToolCallDelta {
  const delta: ToolCallDelta = { index: call.index };

  if (call.id) delta.id = call.id;
  if (call.function?.name) delta.name = call.function.name;
  if (typeof call.function?.arguments === 'string') {
    delta.arguments = call.function.arguments;
  }

  return delta;
}

function isEmptyChunk(chunk: ChatChunk): boolean {
  return (
    chunk.content === undefined &&
    chunk.tool_calls === undefined &&
    chunk.finish_reason === undefined
  );
}

function buildGeneration(request: ChatRequest): GenerationParams {
  const params: GenerationParams = {};

  if (request.temperature !== undefined) params.temperature = request.temperature;
  if (request.maxTokens !== undefined) params.max_tokens = request.maxTokens;
  if (request.topP !== undefined) params.top_p = request.topP;
  if (request.responseFormat === 'json') {
    params.response_format = { type: 'json_object' };
  }

  return params;
}

function buildMessages(
  request: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return request.messages.map((message) => {
    switch (message.role) {
      case 'system':
        return { role: 'system' as const, content: message.content };
      case 'user':
        return { role: 'user' as const, content: message.content };
      case 'assistant':
        return toAssistantMessage(message.content, message.tool_calls);
      case 'tool':
        return {
          role: 'tool' as const,
          tool_call_id: message.tool_call_id!,
          content: message.content,
        };
    }
  });
}

function toAssistantMessage(
  content: string,
  toolCalls: ToolCall[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam {
  if (!toolCalls || toolCalls.length === 0) {
    return { role: 'assistant', content };
  }

  return {
    role: 'assistant',
    content,
    tool_calls: toolCalls.map((call) => ({
      id: call.id,
      type: 'function' as const,
      function: { name: call.name, arguments: call.arguments },
    })),
  };
}

function buildTools(
  request: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!request.tools || request.tools.length === 0) return undefined;

  return request.tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function asLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;

  const detail = err instanceof Error ? err.message : String(err);
  return new LLMError(`OpenAI API error: ${detail}`, { cause: err });
}
