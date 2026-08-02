# AG-UI: rendering a run for a client that speaks another protocol

This example adds no component to a flow. It changes what the *run looks like on
the wire*, by supplying an **encoder**, the one plugin kind that is not part of
the flow at all.

[AG-UI](https://docs.ag-ui.com) is a streaming event protocol for agent↔UI
interaction, and the one CopilotKit speaks. heddle's own events already carry most
of its lifecycle, so this encoder is mostly a rename and an id, plus the three
pieces of bookkeeping that the two models genuinely disagree about, which are
commented in `encoder.mjs` where they happen.

| File | What it is |
|------|------------|
| `encoder.json` | Declares the encoder: its `protocol` name and the `contentType` it produces |
| `encoder.mjs` | The rendering: `encode(event)` per run event, `finish()` at the end |
| `flow.json` | A minimal flow, so there is a lifecycle to render |

## How an encoder is selected

Not by the spec, and not by the operator. **Whoever asked for the run picks it**:
`--protocol` on the CLI, `?protocol=` over HTTP.

```
POST /v1/runs?stream=true&protocol=ag-ui
```

That is the honest owner. Two clients hitting the same flow can legitimately want
different renderings of it, and neither the flow's author nor the person running
the server is in a position to know which. A spec that names `AgUiEncoder` as a
`component_type` is refused, saying so.

`heddle`, or saying nothing at all, gets heddle's own frames, which are now one
encoder among however many are loaded rather than a privileged path beside them.
A plugin may not claim that name.

## Run it

One command, no server, run from the repository root:

```bash
heddle run examples/ag-ui/flow.json --plugin ./examples/ag-ui/encoder.json --protocol ag-ui --input '{"query":"hello"}'
```

(From a source checkout, `pnpm build` first and substitute
`node packages/cli/dist/heddle.js` for `heddle`.)

```
{"data":{"type":"RUN_STARTED","threadId":"5d4ed795-86dc-4b50-a1ea-a08e1cd2b3f8","runId":"5d4ed795-86dc-4b50-a1ea-a08e1cd2b3f8"}}
{"data":{"type":"STEP_STARTED","stepName":"start"}}
{"data":{"type":"STEP_FINISHED","stepName":"start"}}
{"data":{"type":"STATE_SNAPSHOT","snapshot":{"query":"hello"}}}
{"data":{"type":"STEP_STARTED","stepName":"end"}}
{"data":{"type":"STEP_FINISHED","stepName":"end"}}
{"data":{"type":"STATE_SNAPSHOT","snapshot":{"query":"hello"}}}
{"data":{"type":"RUN_FINISHED","threadId":"5d4ed795-86dc-4b50-a1ea-a08e1cd2b3f8","runId":"5d4ed795-86dc-4b50-a1ea-a08e1cd2b3f8"}}
```

One JSON frame per line, because stdout is not an HTTP response body and SSE's
blank-line records buy nothing here. The final state a plain `heddle run` prints
is not appended: stdout is the frame stream, and `flow_complete` already carries
the run state for an encoder that wants it.

## Run it over HTTP

Same encoder, same frames, different framing. Start a server that accepts
submitted code, since here the encoder arrives with the request:

```bash
heddle-server --allow-request-code --port 8080
```

(`npm install -g @heddle-run/server` provides `heddle-server`; from a source
checkout it is `node packages/server/dist/heddle-server.js`.)

Then submit the flow and the encoder together, and read the frames as they
arrive. `jq` builds the body so the files below are the ones actually sent:

```bash
jq -n --arg source "$(cat examples/ag-ui/encoder.mjs)" --argjson manifest "$(cat examples/ag-ui/encoder.json)" --arg flow "$(cat examples/ag-ui/flow.json)" '{flow: $flow, inputs: {query: "hello"}, plugins: [{name: "ag-ui", manifest: $manifest, source: $source}]}' | curl -sN -X POST 'http://127.0.0.1:8080/v1/runs?stream=true&protocol=ag-ui' -H 'content-type: application/json' -d @-
```

```
data: {"type":"RUN_STARTED","threadId":"…","runId":"…"}

data: {"type":"STEP_STARTED","stepName":"start"}

data: {"type":"STEP_FINISHED","stepName":"start"}

data: {"type":"STATE_SNAPSHOT","snapshot":{"query":"hello"}}

data: {"type":"STEP_STARTED","stepName":"end"}

data: {"type":"STEP_FINISHED","stepName":"end"}

data: {"type":"STATE_SNAPSHOT","snapshot":{"query":"hello"}}

data: {"type":"RUN_FINISHED","threadId":"…","runId":"…"}
```

Every frame is **nameless**, with no `event:` line here and no `"event"` key on the
CLI, carrying its type inside the payload instead. That is what AG-UI requires, and it is why
`WireFrame.event` is optional: heddle's own frames put the type in the name so a
browser can subscribe to it, and AG-UI does the opposite.

For comparison, drop the `protocol` parameter and the same run comes back as
`event: flow_start` / `data: {"type":"flow_start",…}`. `--protocol heddle` on the
CLI is the same thing a line at a time:

```
{"event":"flow_start","data":{"type":"flow_start"}}
{"event":"node_start","data":{"type":"node_start","nodeName":"start","nodeType":"StartNode","attempt":1,"state":{"query":"hello"}}}
```

## What an encoder gets, and what it cannot do

`capabilities` is empty in the manifest and that is not an oversight: `Event →
frames` asks heddle for no tool, no model and no workspace, so an encoder is the
one kind that is complete with an empty grant.

It is also strictly one-directional. There is no verdict to return and no way to
affect the run being rendered; given a return path it would be middleware with
none of the ordering rules a seam has. The consequence shows up in `finish()`:
AG-UI's `RUN_FINISHED` and `RUN_ERROR` are mutually exclusive, nothing tells the
encoder which happened, so it reads the outcome off the stream instead. heddle
emits `flow_complete` only on success, so having seen one *is* success.

## Where the two event models disagree

Most of this encoder is a rename and an id. The interesting part is the handful of
places where heddle's model and AG-UI's are both reasonable and do not line up.
Each is commented in `encoder.mjs` where it happens, and each is a decision any
encoder author will have to make:

- **Message boundaries are the encoder's.** heddle emits no event when a model's
  answer begins, because it cannot honestly claim one is starting before knowing
  whether the node will stream at all. It does say which node each `token_delta`
  belongs to, and a node's deltas are contiguous, so a message opens on the first
  delta for a node and closes when that node finishes.
- **A message id is minted per node visit.** heddle's `attempt` cannot serve: it
  is absent from `token_delta`, and it resets when the flow advances, so a loop
  revisiting a streaming node would reuse an id. AG-UI treats a repeated
  `TEXT_MESSAGE_START` as a no-op and appends the content, so a reused id does not
  fail. It silently glues two turns into one message.
- **`node_error` is not `RUN_ERROR`, but it does close the step.** A node error is
  not terminal: a `nodeError` middleware may retry, and the same node can fail and
  then succeed. Rendering it as `RUN_ERROR` would tell every client the run was
  over while it carried on. Leaving the *step* open, though, means the retry emits
  a second `STEP_STARTED` for a step already active, which AG-UI's verifier
  refuses, aborting a run heddle went on to complete.
- **A tool result is its own message.** `TOOL_CALL_RESULT.messageId` names a new
  tool message rather than the assistant message the call belongs to, so it gets
  an id of its own; `parentMessageId` on `TOOL_CALL_START` is what points back.
- **A failed tool is a result whose content is the error.** heddle emits
  `tool_result` with an `error` and no `toolResult`; AG-UI's frame has a required
  `content` and no error field, so the message goes where the model's own copy of
  it goes.
- **`STATE_SNAPSHOT` replaces the client's whole state**, while
  `node_complete.state` is only that node's own output, and the runner merges it in
  one line later. So the encoder accumulates the run state itself; sending a node's
  output as a snapshot would delete what earlier nodes put there. The flow above
  hides this, because `StartNode` and `EndNode` compile to a passthrough whose
  output already *is* the merged state.
