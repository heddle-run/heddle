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

/** OpenAIProvider implements Provider using the OpenAI API. */
export class OpenAIProvider implements Provider {
  private client: OpenAI;

  constructor(opts?: { apiKey?: string; baseURL?: string }) {
    this.client = new OpenAI(opts);
  }

  async chatCompletion(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): Promise<ChatResponse> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: buildMessages(req),
          tools: buildTools(req),
        },
        { signal },
      );

      if (!completion.choices || completion.choices.length === 0) {
        throw new LLMError('no choices in response');
      }

      const choice = completion.choices[0];
      const resp: ChatResponse = {
        content: choice.message.content ?? '',
        finish_reason: choice.finish_reason ?? '',
      };

      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        resp.tool_calls = choice.message.tool_calls.map(
          (tc): ToolCall => ({
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          }),
        );
      }

      return resp;
    } catch (err) {
      throw asLLMError(err);
    }
  }

  /**
   * The same request with `stream: true`, translated chunk by chunk.
   *
   * A generator, so nothing is sent until the caller iterates: the request and
   * the consumption of its response are one act here, and a stream created but
   * never read would hold a connection open until the socket timed out.
   */
  async *chatCompletionStream(
    signal: AbortSignal | undefined,
    req: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: buildMessages(req),
          tools: buildTools(req),
          stream: true,
        },
        { signal },
      );

      let sawChoice = false;
      for await (const part of stream) {
        // Chunks with no choices are routine, not a fault: the usage-only
        // final chunk and the content-filter preamble some OpenAI-compatible
        // endpoints send both look like this.
        const choice = part.choices?.[0];
        if (!choice) continue;
        sawChoice = true;

        const chunk = toChunk(choice);
        // A chunk that says nothing is every stream's opening frame — the one
        // carrying `role: assistant` and no content. Dropping it here means no
        // consumer has to learn to ignore an empty delta.
        if (
          chunk.content === undefined &&
          chunk.tool_calls === undefined &&
          chunk.finish_reason === undefined
        ) {
          continue;
        }
        yield chunk;
      }

      if (!sawChoice) {
        // The streaming twin of "no choices in response". Ending the iteration
        // quietly would hand the caller a blank answer indistinguishable from
        // a model that genuinely replied with nothing.
        throw new LLMError('the model stream closed without sending any choices');
      }
    } catch (err) {
      throw asLLMError(err);
    }
  }
}

/**
 * Carry the provider's own words. "OpenAI API error" on its own is the least
 * useful thing to tell someone whose key is wrong, whose model id does not
 * exist, or who has run out of credit — three failures that need three
 * different fixes. The credential in the message is the caller's own, and
 * providers redact it in their errors regardless.
 */
function asLLMError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new LLMError(`OpenAI API error: ${detail}`, { cause: err });
}

/** Translate one streamed choice into the wire-neutral chunk shape. */
function toChunk(
  choice: OpenAI.Chat.Completions.ChatCompletionChunk.Choice,
): ChatChunk {
  const chunk: ChatChunk = {};

  if (choice.delta.content) {
    chunk.content = choice.delta.content;
  }

  if (choice.delta.tool_calls && choice.delta.tool_calls.length > 0) {
    chunk.tool_calls = choice.delta.tool_calls.map((tc): ToolCallDelta => {
      const delta: ToolCallDelta = { index: tc.index };
      if (tc.id) delta.id = tc.id;
      if (tc.function?.name) delta.name = tc.function.name;
      // Not `if (arguments)`: an empty-string fragment is legal and appending
      // it is a no-op, but the field's presence is how a caller tells a
      // fragment of a call apart from its announcement.
      if (typeof tc.function?.arguments === 'string') {
        delta.arguments = tc.function.arguments;
      }
      return delta;
    });
  }

  if (choice.finish_reason) {
    chunk.finish_reason = choice.finish_reason;
  }

  return chunk;
}

function buildMessages(
  req: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return req.messages.map((msg) => {
    switch (msg.role) {
      case 'system':
        return {
          role: 'system' as const,
          content: msg.content,
        };
      case 'user':
        return { role: 'user' as const, content: msg.content };
      case 'assistant': {
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          return {
            role: 'assistant' as const,
            content: msg.content,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            })),
          };
        }
        return {
          role: 'assistant' as const,
          content: msg.content,
        };
      }
      case 'tool':
        return {
          role: 'tool' as const,
          tool_call_id: msg.tool_call_id!,
          content: msg.content,
        };
    }
  });
}

function buildTools(
  req: ChatRequest,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!req.tools || req.tools.length === 0) return undefined;
  return req.tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
