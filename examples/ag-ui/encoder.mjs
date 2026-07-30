function createEncoder(runId) {
  let openMessage;
  let completed = false;
  let lastError;
  let visit = 0;
  let runState = {};

  const idFor = (event) => `${event.nodeName ?? 'run'}#${visit}`;

  const closeMessage = () => {
    if (openMessage === undefined) return [];
    const frames = [{ data: { type: 'TEXT_MESSAGE_END', messageId: openMessage } }];
    openMessage = undefined;
    return frames;
  };

  return {
    encode(event) {
      switch (event.type) {
        case 'flow_start':
          return [{ data: { type: 'RUN_STARTED', threadId: runId, runId } }];

        case 'node_start':
          visit++;
          runState = { ...runState, ...event.state };
          return [{ data: { type: 'STEP_STARTED', stepName: event.nodeName } }];

        case 'token_delta': {
          const id = idFor(event);
          const frames = [];
          if (openMessage !== id) {
            frames.push(...closeMessage());
            frames.push({
              data: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
            });
            openMessage = id;
          }
          frames.push({
            data: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: event.delta },
          });
          return frames;
        }

        case 'tool_call':
          return [
            {
              data: {
                type: 'TOOL_CALL_START',
                toolCallId: event.toolCallId,
                toolCallName: event.toolName,
                parentMessageId: idFor(event),
              },
            },
            {
              data: {
                type: 'TOOL_CALL_ARGS',
                toolCallId: event.toolCallId,
                delta: JSON.stringify(event.toolArgs ?? {}),
              },
            },
            { data: { type: 'TOOL_CALL_END', toolCallId: event.toolCallId } },
          ];

        case 'tool_result':
          return [
            {
              data: {
                type: 'TOOL_CALL_RESULT',
                messageId: `${idFor(event)}:${event.toolCallId}`,
                toolCallId: event.toolCallId,
                content: event.error
                  ? `Error: ${event.error.message}`
                  : typeof event.toolResult === 'string'
                    ? event.toolResult
                    : JSON.stringify(event.toolResult ?? null),
                role: 'tool',
              },
            },
          ];

        case 'node_complete': {
          const frames = closeMessage();
          frames.push({ data: { type: 'STEP_FINISHED', stepName: event.nodeName } });
          if (event.state) {
            runState = { ...runState, ...event.state };
            frames.push({ data: { type: 'STATE_SNAPSHOT', snapshot: runState } });
          }
          return frames;
        }

        case 'node_error': {
          lastError = event.error?.message ?? 'a node failed';
          const frames = closeMessage();
          frames.push({ data: { type: 'STEP_FINISHED', stepName: event.nodeName } });
          return frames;
        }

        case 'flow_complete':
          completed = true;
          return closeMessage();

        case 'warning':
        case 'plugin_log':
          return [
            {
              data: {
                type: 'CUSTOM',
                name: event.type,
                value: { message: event.message, level: event.level, node: event.nodeName },
              },
            },
          ];

        default:
          return [];
      }
    },

    finish() {
      const frames = closeMessage();
      frames.push(
        completed
          ? { data: { type: 'RUN_FINISHED', threadId: runId, runId } }
          : {
              data: {
                type: 'RUN_ERROR',
                message: lastError ?? 'the run ended without completing',
                code: 'HEDDLE_RUN_INCOMPLETE',
              },
            },
      );
      return frames;
    },
  };
}

const encoders = new Map();
const encoderFor = (ctx) => {
  let encoder = encoders.get(ctx.runId);
  if (!encoder) {
    encoder = createEncoder(ctx.runId);
    encoders.set(ctx.runId, encoder);
  }
  return encoder;
};

serve({
  AgUiEncoder: {
    encode: (event, ctx) => encoderFor(ctx).encode(event),
    finish: (ctx) => {
      const encoder = encoderFor(ctx);
      encoders.delete(ctx.runId);
      return encoder.finish();
    },
  },
});
