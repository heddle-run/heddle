import OpenAI from 'openai';
import type {
  ChatRequest,
  ChatResponse,
  Provider,
  ToolCall,
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
    // Build messages
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      req.messages.map((msg) => {
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

    // Build tools
    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined =
      req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined;

    try {
      const completion = await this.client.chat.completions.create(
        {
          model: req.model,
          messages,
          tools,
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
      if (err instanceof LLMError) throw err;
      // Carry the provider's own words. "OpenAI API error" on its own is the
      // least useful thing to tell someone whose key is wrong, whose model id
      // does not exist, or who has run out of credit — three failures that
      // need three different fixes. The credential in the message is the
      // caller's own, and providers redact it in their errors regardless.
      const detail = err instanceof Error ? err.message : String(err);
      throw new LLMError(`OpenAI API error: ${detail}`, { cause: err });
    }
  }
}
