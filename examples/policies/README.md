# Policies: retry, approval and rate limiting

This example adds nothing to a flow. It supplies three **middleware** — the one
plugin kind no document may name, installed by whoever runs heddle and consulted
on every node of every flow that host serves.

| File | What it is |
|------|------------|
| `policies.json` | The manifest: three middleware, the seams each hooks, and a schema per set of settings |
| `policies.mjs` | The policies themselves |
| `flow.json` | A flow whose tool fails, so `nodeError` has something to decide about |
| `gated-flow.json` | An agent that asks for a command the operator forbids |
| `tools/` | `flaky` (always fails) and `shell` (reports rather than runs) |

The manifest is named `policies.json` because the program beside it is
`policies.mjs`. A manifest loaded from disk is found by the entry point's name,
or by a `command` it declares.

## Who chooses a middleware

Nobody in the flow, and nobody in the request. That is the whole distinction:

| Kind | Chosen by |
|---|---|
| node, transform, provider | the spec |
| encoder | the request, with `?protocol=` |
| **middleware** | **the operator, with `--plugin`** |

A spec that writes `RetryPolicy` as a `component_type` is refused, saying so. A
plugin submitted to `heddle-server` that declares middleware is refused with a
400, whether or not `--allow-request-code` is on. `--plugin` is the only door.

## Run them

Build first, and run from the repository root.

### `nodeError` — a node that failed

`flaky` exits non-zero with a message that looks transient. `RetryPolicy` retries
it with a growing backoff, and substitutes a stated value once the attempts are
spent:

```bash
node packages/cli/dist/heddle.js run examples/policies/flow.json --tools-dir ./examples/policies/tools --plugin ./examples/policies/policies.json --plugin-config RetryPolicy='{"backoffMs":50,"substitute":{"answer":"unavailable, ask again later"}}' --input '{"query":"anything"}'
```

```
[lookup] Error: ToolError: execution failed with exit code 1: flaky: upstream timed out after 5000ms
[lookup] warn: "lookup" failed transiently (attempt 1 of 3): …
Warning: "RetryPolicy" is retrying "lookup" after it failed (attempt 1 of 3), in 50ms.
[lookup] warn: "lookup" failed transiently (attempt 2 of 3): …
Warning: "RetryPolicy" is retrying "lookup" after it failed (attempt 2 of 3), in 100ms.
Warning: "RetryPolicy" supplied a result for "lookup" after it failed, so the run continues.
          The node did not produce this.
{
  "query": "anything",
  "answer": "unavailable, ask again later"
}
```

Three attempts, not more: `--max-node-attempts` is heddle's ceiling and a
middleware asking to go past it is refused with a warning. A ceiling a middleware
can raise is not a ceiling.

Set `FLAKY_MODE=fatal` and the tool reports an error `retryOn` does not match, so
the policy substitutes immediately without retrying.

### `toolCall` — a call the operator will not allow

`gated-flow.json` uses a stub model, so this needs no credential. It asks for
`shell` with `rm -rf /var/data`:

```bash
node packages/cli/dist/heddle.js run examples/policies/gated-flow.json --tools-dir ./examples/policies/tools --plugin ./examples/policies/policies.json --plugin-config ApprovalGate='{"guard":{"shell":["rm -rf","sudo"]}}' --input '{"task":"clean up the data directory"}'
```

```
Warning: "ApprovalGate" refused the tool call "shell": "shell" may not be called
         with "rm -rf" on this host. Try something that does not need it.
{
  "task": "clean up the data directory",
  "result": "Understood, I will stop there."
}
```

**A refused call is still answered.** The model receives a tool message carrying
the reason, and replies to it — the turn is not skipped. That is not a courtesy:
a provider refuses a request whose assistant message asked for a call that no
tool message answers, so a rejection has to be a reply. It is also why `reject`
carries a reason rather than being a way to abandon a turn.

Drop the `--plugin-config` and the same run lets the command through, because the
gate guards nothing it was not told to guard.

### `modelCall` — and two policies composing

`RateLimit` holds the whole process to a rate. The flow above makes two model
calls, so a limit of one refuses the second:

```bash
node packages/cli/dist/heddle.js run examples/policies/gated-flow.json --tools-dir ./examples/policies/tools --plugin ./examples/policies/policies.json --plugin-config RateLimit='{"callsPerMinute":1}' --plugin-config RetryPolicy='{"retryOn":["in the last minute"],"backoffMs":10,"substitute":{"result":"busy, try again shortly"}}' --input '{"task":"anything"}'
```

```
[agent] Error: LLMError: "RateLimit" refused the model call for "agent": this host
        has made 1 model calls in the last minute and allows 1
[agent] warn: "agent" failed transiently (attempt 1 of 3): …
Warning: "RetryPolicy" is retrying "agent" after it failed (attempt 1 of 3), in 10ms.
…
Warning: "RetryPolicy" supplied a result for "agent" after it failed, so the run continues.
{
  "task": "anything",
  "result": "busy, try again shortly"
}
```

Two policies, two seams, one chain. `RateLimit` refuses at `modelCall.before`,
which fails the node; that failure is what `nodeError` is consulted about, and
`RetryPolicy` decides what to do with it. Neither knows the other exists — the
operator composed them by loading both.

The chain is walked in reverse load order and the first non-`pass` verdict wins,
so the order of `--plugin` flags is something an operator can change without
touching a plugin or a flow.

## On a server

The same two flags:

```bash
node packages/server/dist/heddle-server.js \
  --tools-dir ./examples/policies/tools \
  --plugin ./examples/policies/policies.json \
  --plugin-config ApprovalGate='{"guard":{"shell":["rm -rf","sudo"]}}'
```

Everything is settled before the port opens: a manifest that will not parse, or a
`--plugin-config` that fails the schema in it, is a server that does not start.
`GET /v1/capabilities` reports what is installed under `middleware`.

One thing changes, and `RateLimit` is written the way it is because of it.

## The one kind of state a shared plugin may keep

On a server, **one process per plugin serves every run**. That is what makes an
MCP session or a warm connection pool worth holding, and it is why `RateLimit`
counts *calls this process has made* rather than calls this run has made.

A per-run budget is the obvious thing to write and is wrong here. There is no run
id in a middleware's context, deliberately: a middleware is named nowhere in the
caller's document, so handing it the run's identity or its data would disclose one
caller's information to code they never asked for. A counter that outlives a run
is a counter that silently belongs to somebody else.

A process-wide rate is different. It is a fact about this process, which is
exactly the thing being limited — so the state is honest, and the same code means
the same thing on the CLI, where the process serves one run anyway.

heddle enforces the one part of this it can see: an installed plugin asking to run
a tool without naming the call it is acting for is refused rather than served from
whichever run reached the process first.

## What a middleware gets, and what it does not

`ctx.component` is the operator's settings — `{}` when they gave none, never
undefined. `ctx.attempt` and `ctx.maxAttempts` say where an attempt sits.
`ctx.admits` carries the verdicts the current seam will honour, sent with the
handshake, so a policy that works at more than one seam can fall back rather than
send a verdict it would be refused for.

It does **not** get the run's state. `subject` names which node, tool or model
call is in question and `outcome` says how it went; a component that needs the
data itself is a plugin node, which the flow names.

## Verdicts, by seam

| Seam | Half | Verdicts |
|---|---|---|
| `nodeError` | after | `pass` `replace` `retry` `fail` |
| `toolCall` | before | `proceed` `modify` `replace` `reject` |
| `toolCall` | after | `pass` `replace` `fail` |
| `modelCall` | before | `proceed` `modify` `replace` `reject` |
| `modelCall` | after | `pass` `replace` `retry` `fail` |

`retry` is admitted after a model call and refused after a tool call, and the
difference is what has already been said. A failed tool call leaves an assistant
message asking for it in the conversation, so re-issuing is not re-entering a
clean state. A failed model call has changed nothing, so it is.

`modify` is the only verdict that hands heddle something it then *sends
somewhere*, so it is checked hardest: every field is type-checked and anything you
do not supply keeps the value you were shown. A returned object is an edit, not a
replacement.

## The stub model

`StubModelConfig` is a provider, not a policy. It exists so the tool-call demo
runs without a credential — it answers the first request with a tool call and the
second with a sentence. Replace its `llm_config` in `gated-flow.json` with a real
one and nothing about the policies changes.
