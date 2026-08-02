# An approval gate

A tool call that stops and waits for a person.

```bash
heddle run flow.yaml \
  --plugin examples/approval-gate/gate.json \
  --plugin-config ApprovalGate='{"tools":["refund"]}' \
  --session support-42 \
  --input '{"query":"refund order 991"}'
```

When the agent asks for `refund`, the run stops:

```
Stopped for a human: "ApprovalGate" is asking.
{
  "tool": "refund",
  "arguments": { "order": "991", "amount": 4200 },
  "question": "Approve refund?",
  "reply": { "approved": "true or false" }
}

Answer it with:
  heddle run <flow> --session support-42 --resume --answer '{"approved":true}'
```

The process can exit. The run is in the session, and anything holding the session id can continue it:
a different terminal, a different machine if the store is shared, an hour later.

```bash
heddle run flow.yaml \
  --plugin examples/approval-gate/gate.json \
  --plugin-config ApprovalGate='{"tools":["refund"]}' \
  --session support-42 --resume --answer '{"approved":true}'
```

Over HTTP it is the same two steps: a run naming a session answers `202` with the question, and a
second request with `"resume": true` and an `"answer"` object continues it.

## `reject` was already there. What `suspend` adds

`toolCall.before` could always refuse a call, and the model is told and carries on. That is a gate that
always says no, and it needs no session, no checkpoint and no store.

`suspend` is the other half: **a way to say yes later.** The run stops, is written into its session,
and starts again where it was. The difference is not how firmly the call is refused; it is whether
the answer can arrive after the process that asked has gone.

## What resuming does not repeat

The bookmark in the checkpoint holds the conversation as it stood, so a resumed run:

- **does not call the model again** for the round it stopped in, since that response is in the bookmark;
- **does not re-run tools that already ran** in that round, since their results are in the bookmark too;
- **does run the calls the round never reached**, because they belong to a model request already in the
  conversation, and a provider refuses a conversation where an assistant asked for a call that no
  tool message answers.

That last one is the reason the bookmark records `remaining` rather than just "re-enter this node".
Tool calls are not idempotent, so a resume that repeated them would not be slow; it would be wrong.

The one thing that genuinely cannot be replayed is a partial token stream. A suspension mid-stream
drops the tokens already sent; the answer is not final until the round ends, so a client that
rendered a partial answer re-renders on resume.

## What the model sees

The answer comes back as the tool's *result*: the model gets `{"approved":true}` where it expected
`refund`'s output. So this shape suits tools whose result the agent only checks. A gate that wants
the tool to actually run once approved is a different design, approving the arguments and then
letting the call proceed, and `suspend` supports that too: the resumed run can carry whatever the middleware
needs to let it through the second time.

## Where it can be used

`suspend` is admitted at `toolCall.before` and `node.before`, and nowhere else. Not at `modelCall`,
because what would be resumed there is a request the run has not decided to make yet. A policy
wanting a person before the model is consulted asks at `node`, which owns whether the node runs at
all. Not at any `after` half, because by then the work is done.

**The two seams differ in one way that matters when you write the gate.** A `toolCall` suspension is
never consulted again: the bookmark replays the answer as the call's result, so the gate is not
asked a second time. A `node` suspension *is*: resuming re-enters the node, and every `before` hook
runs afresh. A node gate that does not check `ctx.answered` will suspend forever:

```js
before({ subject }, ctx) {
  if (subject.nodeName !== 'deploy') return { action: 'proceed' };
  if (ctx.answered) return { action: 'proceed' };   // ← without this, it loops
  return { action: 'suspend', ask: { question: 'Ship it?' } };
}
```

`ctx.answered` is set only on that path, and holds exactly what the human sent.

A suspension needs somewhere to be written down. A run with no session is refused with an error
saying so, rather than stopping with no way back.
