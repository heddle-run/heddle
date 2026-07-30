/**
 * An AG-UI encoder: heddle's run events rendered as the protocol CopilotKit and
 * other AG-UI clients already speak.
 *
 * https://docs.ag-ui.com — event names are SCREAMING_SNAKE and travel *inside*
 * the payload, so every frame here is nameless. That is the shape AG-UI requires
 * and the reason `WireFrame.event` is optional: a client reads one stream and
 * switches on `data.type` rather than on an SSE event name.
 *
 * Three pieces of bookkeeping do the real work, and each exists because heddle's
 * event model and AG-UI's disagree about something.
 *
 * 1. **Message boundaries.** AG-UI wants TEXT_MESSAGE_START before the first
 *    delta of a message and TEXT_MESSAGE_END after the last. heddle emits
 *    neither, and cannot honestly: it would have to claim a message was starting
 *    before knowing whether the node streams at all — an agent carrying a `post`
 *    transform streams nothing, and one calling tools streams rounds whose text
 *    is discarded. What heddle does say is which node each delta belongs to, and
 *    a node's deltas are contiguous. So a message opens on the first delta seen
 *    for a node and closes when that node finishes.
 *
 * 2. **The outcome.** RUN_FINISHED and RUN_ERROR are mutually exclusive and
 *    `finish` is told nothing, so the outcome is read off the stream: heddle
 *    emits `flow_complete` only on success, so having seen one *is* success.
 *    That is the encoder inferring what happened rather than being handed a
 *    verdict, which is the whole of why this kind needs no return path.
 *
 * 3. **`node_error` is not RUN_ERROR.** Since middleware landed, a node error is
 *    not terminal — a `nodeError` middleware may retry, and the same node can
 *    fail and then succeed. Rendering it as RUN_ERROR would tell every client the
 *    run was over while it carried on, which is why the error is remembered here
 *    and only spent at `finish`, if nothing succeeded after it. The *step* does
 *    close, though: a retry re-enters the node and AG-UI refuses a second
 *    `STEP_STARTED` for a step already active, so a step left open here would
 *    make a conforming client abort a run that heddle went on to complete.
 *
 * 4. **A message id is per node *visit*, minted here.** heddle's own `attempt`
 *    cannot serve: it is absent from `token_delta` altogether, and it resets to 1
 *    when the flow advances — so a loop revisiting a streaming node would reuse
 *    an id whichever way it were read. AG-UI's reducer treats a repeated
 *    `TEXT_MESSAGE_START` as a no-op and appends the content, so a reused id does
 *    not fail: it silently concatenates two turns into one message.
 *
 * 5. **A failed tool is a result whose content is the error.** heddle emits
 *    `tool_result` with an `error` and no `toolResult`; AG-UI's
 *    `TOOL_CALL_RESULT` has a required `content` and no error field at all. So
 *    the message goes where the model's copy of it goes — into `content` —
 *    rather than being rendered as a tool that successfully returned nothing.
 *
 * And one thing that is not a disagreement so much as a trap: **`STATE_SNAPSHOT`
 * replaces the client's whole state**, while `node_complete.state` is only that
 * node's own output. Sending the latter as the former deletes everything earlier
 * nodes put there, so the run state is accumulated here the way the runner
 * accumulates it.
 */

function createEncoder(runId) {
  // Which node has an open TEXT_MESSAGE, so it can be closed exactly once.
  let openMessage;
  let completed = false;
  let lastError;
  // Which visit to a node this is. Bumped on `node_start`, which fires once per
  // visit *and* once per retry — the two things `attempt` cannot tell apart.
  let visit = 0;
  // The run state as the client will hold it, since a snapshot is a replacement.
  let runState = {};

  /** The id of the message the node currently being visited is producing. */
  const idFor = (event) => `${event.nodeName ?? 'run'}#${visit}`;

  /** Close an open message, if there is one. */
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
          // threadId is required and heddle has no notion of a thread — a run is
          // the whole of what it knows about — so the run's own id serves as one.
          // A client that groups runs into a conversation is supplying that
          // grouping from outside heddle either way.
          return [{ data: { type: 'RUN_STARTED', threadId: runId, runId } }];

        case 'node_start':
          visit++;
          // `node_start` carries the accumulated run state, which is where the
          // run's inputs enter the rendering.
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
          // heddle knows the whole call by the time it says anything, so the
          // three-frame sequence is emitted at once rather than streamed. The
          // arguments go out as the JSON text TOOL_CALL_ARGS asks for.
          return [
            {
              data: {
                type: 'TOOL_CALL_START',
                toolCallId: event.toolCallId,
                toolCallName: event.toolName,
                // The assistant message this call belongs to, which is the one
                // the node's own deltas are building.
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
                // A *new* tool message, so it needs an id of its own — the
                // parent's would collide with the assistant message and with
                // every other result in the same node, and a client keyed by
                // message id keeps one of them.
                messageId: `${idFor(event)}:${event.toolCallId}`,
                toolCallId: event.toolCallId,
                // Rule 5: a failure has nowhere else to go.
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
            // `node_complete.state` is the node's *own output*; the run state is
            // that merged over what came before, which is what the runner does
            // one line later. A snapshot is a whole-state replacement, so the
            // merge happens here or each node wipes the client's state.
            runState = { ...runState, ...event.state };
            frames.push({ data: { type: 'STATE_SNAPSHOT', snapshot: runState } });
          }
          return frames;
        }

        case 'node_error': {
          // Remembered, not rendered — see rule 3 above.
          lastError = event.error?.message ?? 'a node failed';
          // The *step* still closes, even though the run does not. A retry
          // re-enters the same node and emits a second `node_start`, and AG-UI
          // refuses a `STEP_STARTED` for a step that is already active — so a
          // step left open here is a client aborting the run at the retry, which
          // is the one outcome a non-terminal error must not cause. This is the
          // same "close on either terminus" rule the message boundary follows.
          const frames = closeMessage();
          frames.push({ data: { type: 'STEP_FINISHED', stepName: event.nodeName } });
          return frames;
        }

        case 'flow_complete':
          completed = true;
          // No RUN_FINISHED here: `finish` owns it, so there is one place that
          // decides between the two terminal events and no way to emit both.
          return closeMessage();

        case 'warning':
        case 'plugin_log':
          // Rendered as CUSTOM rather than dropped, because both carry text a
          // person is meant to read — a granted retry, a plugin's log line — and
          // AG-UI has no lifecycle event that means "something worth saying".
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
          // Includes every `plugin:<Type>:<name>` event, which belongs to
          // whichever plugin minted it and has no AG-UI meaning. An encoder
          // returning [] is how it says an event is not part of its format.
          return [];
      }
    },

    finish() {
      const frames = closeMessage();
      // Exactly one terminal frame, on every path. A client that never receives
      // one waits forever, and "the connection closed" is not something a
      // protocol with a terminal event should have to infer.
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

// One encoder per run. heddle passes the run id on every call, so a single
// process can serve more than one — which it will, if an operator ever installs
// this rather than a caller submitting it.
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
