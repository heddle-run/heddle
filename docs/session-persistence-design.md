# Session Persistence: Design and Roadmap

> Internal design notes — not user documentation; see https://heddle.run/docs.

Status: **landed**, S0 through S5. §2 is archaeology — it describes heddle before any of this, and
is kept because it is the justification. §8 records what each phase actually did, including the three
places the implementation disagreed with the plan.

## 1. Goal

Three features want the same thing, and heddle has it for none of them:

- **A conversation that outlives the process**, continuable from the CLI or over HTTP with the same
  identifier.
- **A run that can be cut and resumed** — durable execution across a crash, a deploy, or a deliberate
  pause.
- **A run that can stop on a human** and start again when they answer.

All three reduce to: somewhere to put a run's state that outlives the run, and a name to find it by.
This document proposes that place (`SessionStore`), its default implementation (files), the way an
operator substitutes their own (a `store` plugin kind), and the order to build it in.

It also retires `--chat`, which is the half-built version of the first feature.

## 2. Where heddle is today

### 2.1 `--chat` is two features fused into one flag

*(`packages/cli/src/chat/session.ts` was deleted in S1. It is cited by symbol below, because a line
number into a file that no longer exists points at nothing.)*

The flag is declared at `packages/cli/src/cli/run.ts:65`. What it does:

- `createSession` writes `~/.heddle/conversations/<id>.json` (`chat/session.ts`, deleted in S1).
- `startChat` renders an Ink TUI (`packages/cli/src/chat/ui.tsx:45`).

`startChatSession` (`run.ts:270`) does both in one breath, and the only writer of a transcript is
`addMessage`, called from the UI (`ui.tsx:89`, `ui.tsx:281`). Persistence is not a thing you can have
without the terminal UI, and the terminal UI is not a thing you can have without persistence.

Four consequences worth naming, because the replacement has to not inherit them:

- **Session ids are timestamps.** `chat-2026-08-01T12-30-00-000Z` (`chat/session.ts`, `createSession`). Two sessions
  started in the same millisecond collide, and an id derived from a clock is guessable — which is
  survivable in a user's home directory and is not survivable on a server (§7.3).
- **Every message rewrites the whole file.** `persist` is `writeFileSync(JSON.stringify(session))`
  (`chat/session.ts`, `persist`). A conversation costs O(n²) bytes to record.
- **`loadSession` is exported and called by nothing.** There is no `--resume`. The history that
  reaches the model comes from the in-memory `session.messages` (`ui.tsx:85`), so the file is written
  and never read: restart the process and you get a new conversation and a new file. **The transcript
  is a log, not a session.**
- **`--chat` and `--protocol` are refused together** (`run.ts:216`), correctly, because the TUI owns
  stdout. But the refusal is attributed to chat rather than to the UI, which is the part that
  actually conflicts.

### 2.2 The server has none of it

`heddle-server` has one run route: `POST /v1/runs` (`packages/server/src/server.ts:213` →
`packages/server/src/runs.ts:70`). `handleRun` reads a body, builds a graph, runs it, writes a result,
and disposes everything it made (`runs.ts:111`). The run's entire state lives in `Runner.walk`'s
locals (`packages/core/src/runner/runner.ts:51`) and dies with the call.

So: **no, `--chat` does not work over HTTP.** There is no session concept, no identifier to pass, and
nothing on disk. It was never a server feature.

### 2.3 `_chat_history` is the one thing that already crosses

`AgentExecutor` reads a magic key off the input state. The constant is declared twice, independently,
in two packages: `packages/core/src/node/agent.ts:30` and `packages/cli/src/chat/ui.tsx:19`.
`openingMessages` (`agent.ts:152`) splices it between the system prompt and the user turn, and
`inputWithoutHistory` (`agent.ts:828`) keeps it out of the user message.

Nothing on the server filters it. `readInputs` (`runs.ts:276`) checks only that `inputs` is an object,
and `_chat_history` is not in `SERVER_SIDE_FIELDS` (`runs.ts:56`). **An HTTP caller can already hold a
multi-turn conversation by maintaining the transcript itself and posting it with every request.** It
is undocumented, unversioned, and entirely the client's to keep.

This is the seed of the design rather than a bug to remove. The engine already has exactly one place
where a prior conversation enters a run. Sessions should fill that place, not invent a second one.
The repo's own design doc already lists it as a gap (`docs/plugin-system-design.md:517`).

### 2.4 What is already checkpointable, and what is not

`Runner.walk`'s entire position is four values (`runner.ts:51`, `runner.ts:99`):

| Value | Type | Serializable |
|---|---|---|
| `nodeOutputs` | `Map<string, State>` | yes — `State.toJSON()` |
| `carried` | `State` | yes |
| `current` | `CompiledNode` | by name |
| `attempt` | `number` | yes |

No closures, no live handles, nothing to reconstruct. **Node-boundary checkpointing is nearly free,
and that is the granularity to start at.**

What is *not* reachable at that granularity is everything inside `node.executor.execute()`
(`runner.ts:159`). An `AgentNode`'s whole tool loop — up to ten rounds of model calls and tool calls
(`agent.ts:110`) — is a single await. A human-in-the-loop approval fires at `toolCall.before`, which
is deep inside it. §6.2 is about that, and it is the only genuinely hard part of this plan.

## 3. What a session is

**Two records, deliberately not one.**

```ts
interface SessionRecord {
  id: string;
  flow?: string;          // where it came from; advisory
  createdAt: string;
  version: number;        // bumped by every write; see §4.2
  turns: Turn[];
}

interface Turn {
  at: string;
  input: Record<string, unknown>;    // what was given to the run
  output?: Record<string, unknown>;  // the final state, when it finished
  error?: { name: string; message: string };
  runId: string;
}

interface Checkpoint {
  runId: string;
  at: string;
  node: string;                                  // where to re-enter
  carried: Record<string, unknown>;
  nodeOutputs: Record<string, Record<string, unknown>>;
  attempt: number;
  suspended?: Suspension;                        // §6.2, absent for a plain checkpoint
}
```

A session has any number of turns and **at most one** checkpoint: a run either finished (no
checkpoint) or did not (one). The checkpoint is deleted when the run completes.

Separate because their access patterns have nothing in common. A transcript is small, ordered, and
read on every single turn. A checkpoint is large, opaque, and read only when resuming. Fusing them
means loading the previous run's entire node-output map to answer "hello".

`Turn.output` is the final `State`, not a rendered string. Today the TUI stores `formatResult(...)`
(`ui.tsx:284`), which throws away structure to produce something printable — fine for a log, wrong for
a record something else will read.

## 4. `SessionStore`

New directory: `packages/core/src/session/`. Core, because the CLI and the server both need it and
core is the only thing they share.

### 4.1 The interface

```ts
export interface SessionStore {
  create(id: string, init?: { flow?: string }): Promise<void>;
  read(id: string): Promise<SessionRecord | undefined>;
  append(id: string, turn: Turn, expect: number): Promise<number>;
  readCheckpoint(id: string): Promise<Checkpoint | undefined>;
  writeCheckpoint(id: string, cp: Checkpoint | null): Promise<void>;
  list(options?: { limit?: number; cursor?: string }): Promise<SessionSummary[]>;
  delete(id: string): Promise<void>;
}
```

Seven methods, and three decisions inside them:

- **`create` exists, and `append` creates too.** This document originally argued there should be no
  `create`, because every caller's first act on a new session is to write a turn to it. That is true
  on the CLI and false on a server, where a conversation begins with an *identifier* — see the S1
  entry in §8. The redundancy is load-bearing rather than sloppy.
- **`expect` is a version and the return is the new one.** Two writers on one session stops being
  hypothetical the moment this is served over HTTP. A lock is something a Redis store would have to
  invent; a compare-and-swap is something every store already has. A mismatch throws
  `SessionConflictError`.
- **No range read.** `read` returns every turn. This is the first thing that will need to change when
  a transcript gets long, and it is deliberately not being solved in v1 — see §9.

### 4.2 The file store, which is the default

`~/.heddle/sessions/<id>/`:

```
meta.json         id, flow, createdAt, version
turns.jsonl       one turn per line, appended
checkpoint.json   present only while a run is unfinished
```

Three changes from today's format, one reason each:

- **JSONL for turns**, so a turn costs its own bytes rather than the transcript's (`chat/session.ts`,
  `persist`, which serialized the whole session per message).
- **A directory rather than a file**, so a checkpoint is a sibling rather than a field, and can be
  written and deleted without touching the transcript.
- **`randomUUID()` for ids**, not a timestamp. §7.3 is why.

Writes are atomic: write a temp file in the same directory, `rename` over the target. A half-written
`checkpoint.json` that a resume then reads is the exact failure this prevents, and rename is atomic on
both platforms heddle supports.

Concurrent writes to one session are serialized by an exclusive lock file (`<id>/.lock`, created
`wx`, with a stale-lock timeout) held across the read-check-write. The `expect` version is still in
the interface because a networked store implements it as a real CAS and should not have to emulate a
lock heddle only needed because the filesystem has no compare-and-swap.

### 4.3 Where the store comes from

A `SessionStore` is resolved once, before any run:

1. A `store` plugin, if one is installed (§5).
2. Otherwise the file store, rooted at `HEDDLE_SESSION_DIR` or `~/.heddle/sessions`.
3. On the server, only if the operator turned sessions on at all (§7.3).

## 5. The `store` plugin kind

A store is installed by whoever runs heddle and is **never named by a spec** — exactly the shape
`middleware` and `encoder` already have. Everything below follows their precedent rather than
inventing a parallel mechanism.

### 5.1 Registry and manifest

- `ComponentKind` gains `'store'` (`packages/core/src/plugin/registry.ts:18`) and **does not** join
  `SPEC_WRITABLE_KINDS` (`registry.ts:26`). A flow cannot ask for a store any more than it can ask
  for a middleware.
- `ManifestKind` gains `'store'` (`packages/core/src/plugin/manifest.ts:13`). It needs no per-kind
  field of its own, and `onlyOn` (`manifest.ts:410`) keeps every other kind's fields off it with no
  new code.
- `HeddlePlugin` gains `stores?: PluginStoreDef[]` (`plugin/types.ts`, `HeddlePlugin`), where
  `PluginStoreDef` is `PluginComponentDef` plus `createStore(config, deps): SessionStore`.
- **At most one store may be installed.** Two is refused at load with a message naming both plugins,
  the same shape as the duplicate-protocol refusal (`registry.ts:270`). This avoids a selector flag:
  there is nothing to select between.
- Configuration comes from `--plugin-config <ComponentType>=<json>`, which already exists and already
  serves middleware (`packages/core/src/plugin/config.ts`). A Postgres store gets its DSN there.

### 5.2 The RPC verbs, for subprocess plugins

`HostMethods` (`plugin/protocol.ts`, `HostMethods`) gains six, mirroring §4.1:

| Verb | Params | Result |
|---|---|---|
| `sessionRead` | `{ componentType, id }` | `SessionRecord \| null` |
| `sessionAppend` | `{ componentType, id, turn, expect }` | `{ version }` |
| `sessionCheckpointRead` | `{ componentType, id }` | `Checkpoint \| null` |
| `sessionCheckpointWrite` | `{ componentType, id, checkpoint, expect }` | `{ version }` |
| `sessionList` | `{ componentType, limit?, cursor? }` | `{ sessions, cursor? }` |
| `sessionDelete` | `{ componentType, id }` | `{}` |

Six is the widest single addition the protocol has taken, and the alternative — one `session` verb
carrying an `op` — is worth naming and rejecting: every existing verb is one operation
(`execute`, `apply`, `callTool`, `chat`, `before`, `after`, `encode`, `finishEncode`, `listTools`),
and an `op` field would be the first dispatcher inside the protocol. If the width is judged too much,
`sessionList` and `sessionDelete` are the two to defer — nothing in the run path calls them; they
serve `heddle sessions ls|rm`.

Two things this does *not* need:

- **No new `PluginCapability`.** Capabilities gate plugin → host calls (`plugin/protocol.ts`, `PluginCapability`). These are
  host → plugin, like every other `HostMethod`.
- **No sandbox change.** A store plugin that talks to a database needs network, which is what
  `--safe --deny-net` would take away — that is the operator's existing decision, made the existing
  way.

One thing it does need saying: **a store is on the hot path of every turn.** `pluginCallTimeout`
applies to each call, and a slow store stalls runs while holding a concurrency slot. On the server the
process is `shared` (`packages/core/src/plugin/loader.ts`, `LoadPluginsOptions.shared`), which is what
makes a connection pool in a store plugin worth having — the same property `heddle-server`'s own help
text already describes at `packages/server/src/heddle-server.ts:31`.

## 6. Cutting a run

### 6.1 Node boundaries

`Runner.walk` takes an optional `{ store, sessionId }`. After each `node_complete`
(`runner.ts:85`), it writes a checkpoint naming the *next* node, the carried state, and the node
outputs. On `flow_complete` it deletes it. `run()` gains a resume path: start from a checkpoint rather
than from `startNode()` (`runner.ts:108`).

This is opt-in per run (`--durable`, or `"durable": true` in a request body) and **not implied by
`--session`**. Most runs are short and a store write per node is a real cost.

What it buys on its own: a run that survives a process death between nodes, and `--resume`. No human
involved, no seam changes, no protocol changes.

### 6.2 Suspension — the part that makes HITL work

A sixth verdict. `BeforeVerdict` (`plugin/protocol.ts`, `BeforeVerdict`) gains:

```ts
| { action: 'suspend'; ask: Record<string, unknown> }
```

admitted by `toolCall.before` and `node.before` in the `SEAMS` table (`packages/core/src/plugin/seams.ts:35`)
and by nothing else. `agentRound.before` is deliberately excluded: its vocabulary is `proceed`/`reject`
by design, and Phase 14 settled that (`docs/plugin-system-design.md:2772`).

When a middleware suspends:

1. The call site throws a `Suspended` sentinel that unwinds to `Runner.walk`.
2. `walk` writes a checkpoint that additionally records **where inside the node it stopped** — the node
   name, the agent's message array as built so far, and the pending tool call.
3. The run ends with a distinguished outcome, **not an error**: CLI prints the session id and the
   question and exits with a reserved code; HTTP answers `202` with `{ session, suspended: { ask } }`;
   SSE emits a `suspended` frame before closing.

Resume supplies the answer, which stands in for the tool result:

```bash
heddle run flow.yaml --session <id> --resume --answer '{"approved": true}'
```

**Why the checkpoint records the message array and not just the node name.** Re-entering an
`AgentNode` from its start would re-execute every tool call already made in that round. Tool calls are
not idempotent. Recording the messages means the model call that produced the pending call is not
re-made (its response is in the array) and the tool results already collected are not re-collected
(their messages are too). This is the whole reason mid-node suspension is more than a node-boundary
checkpoint with extra steps.

**What genuinely cannot be replayed**: a partial token stream. Suspending mid-stream drops the tokens
already emitted to the client. Accept it — the answer is not final until the round ends, and a client
that rendered a partial answer re-renders on resume.

## 7. The surfaces

### 7.1 CLI

```
heddle run <flow>
  --session [id]       Persist this run's conversation. No id creates one and
                       prints it; an id continues (or creates) that session.
  --interactive, -i    Open the terminal chat UI.
  --durable            Checkpoint at every node boundary.
  --resume             Continue this session's unfinished run.
  --answer <json>      The human's answer, with --resume.

heddle sessions ls | show <id> | rm <id>
```

- `-i` alone is today's chat, ephemeral. `-i --session <id>` is today's chat, persisted — and
  **resumable**, seeding its history from the store, which is what `loadSession` was written for and
  never got (§2.1).
- `--session` composes with `--protocol`, because a persisted non-interactive turn is one ordinary run
  with a history injected. The Phase-15 refusal at `run.ts:216` narrows to `--protocol` vs `-i`, which
  is the flag that actually contends for stdout.
- `--chat` is removed outright. It is not aliased: an alias would keep the two features fused, which
  is the thing being fixed.

### 7.2 HTTP

- **`POST /v1/runs` gains `"session": "<id>"`.** The server reads the transcript, injects it as
  history, runs, and appends the turn. Streaming, `?protocol=`, and every encoder are untouched —
  sessions are an input/output concern, not a transport one. `"durable": true` opts into checkpoints.
- **`GET /v1/sessions/:id`** returns the transcript. **`DELETE /v1/sessions/:id`** removes it.
  **`POST /v1/sessions/:id/resume`** takes `{ answer }`.
- **`POST /v1/sessions`** creates an empty session and returns its id, so a client can name one before
  its first run.
- `/v1/capabilities` (`packages/server/src/capabilities.ts:18`) gains
  `sessions: { enabled, store, durable }`, so a client can find out rather than discover by 400.
- `"session"` is **not** added to `SERVER_SIDE_FIELDS` (`runs.ts:56`). It is per-request by design.

### 7.3 What sessions cost the server, stated plainly

- **The server stops being stateless.** Today any replica serves any request, which is what the drain
  message assumes when it says "retry against another replica" (`server.ts:216`). With the file store,
  two replicas do not share sessions. **This is the reason the store is pluggable — not a
  nice-to-have.** Multi-replica means a shared store, and the docs have to say so where an operator
  will read it.
- **There is no authentication** (`heddle-server.ts:83`). A session id is therefore the only thing
  between a caller and someone else's conversation. It must be unguessable, and on the server it is
  **always server-generated**: a request supplying `"session": "alice"` for an unknown id is a 400, not
  a creation. On the CLI a chosen id is fine — the store is the user's own home directory. The docs get
  one blunt line: *a session id is a bearer capability; sessions are not an authorization boundary.*
- **Sessions are off by default on the server.** No store configured means `"session"` in a body is a
  400. Default-on would have every existing deployment start writing conversations to disk on the next
  upgrade, which nobody asked for. `--session-store file --session-dir <path>` turns it on, or
  installing a store plugin does.
- **Retention is unbounded.** Ship `--session-ttl` with a sweep at startup, or say in one sentence that
  retention belongs to the operator. Shipping neither is the option that is not available.

## 8. Roadmap

**Phase S0 — `_chat_history` becomes a contract — landed.** The constant is exported from core and
the CLI's duplicate is gone. `readHistory` now *refuses* a malformed history instead of casting it:
the old code mapped entries with a cast, so a bad one reached the provider as a message with an
undefined role and came back as an API error naming the model. Reserved keys live in
`session/reserved.ts`, and `validate` refuses a flow declaring an input or output by one of them.

**Phase S1 — sessions — landed.** `SessionStore`, the file store, `--session`, `--interactive`,
`heddle sessions ls|show|rm`; `--chat` removed and not aliased. Server: `"session"` on `/v1/runs`,
`POST`/`GET`/`DELETE /v1/sessions`, off unless `--session-store` is given, ids issued rather than
chosen.

> **Diverged from the plan: the store has seven methods, not six.** §4.1 argued there should be no
> `create` because every caller's first act is a write. That is true on the CLI and false on the
> server, where a conversation begins with an *identifier*: `POST /v1/sessions` mints one and hands
> it back before any run has named it, and a session that did not exist until its first turn would
> make the caller's next request a 404 for an id it was just given. The first attempt worked around
> this by writing a placeholder turn and filtering it back out on read — which is the shape of a
> design that is wrong rather than inconvenient. `create` is idempotent, and `append` still creates.

**Phase S2 — the `store` plugin kind — landed.** `ComponentKind` and `ManifestKind` gained `store`;
it stays out of `SPEC_WRITABLE_KINDS`, at most one may be installed, and a submitted plugin
declaring one is refused the way middleware is. `examples/session-store` is a working SQLite store,
exercised out of process by `store-plugin.test.ts`.

> **Diverged from the plan: seven verbs, and each carries the store's config.** §5.2 planned six and
> named the "one `session` verb with an `op`" alternative. Seven is what a seven-method interface
> costs, and the alternative is still refused for the reason given there. What the plan missed
> entirely is that a remote store never receives its `--plugin-config`: there is no verb that
> *constructs* one, so the settings ride along on every call. Writing the example is what surfaced
> it.

**Phase S3 — node-boundary checkpoints — landed.** `RunnerOptions.checkpoints` and `durable`,
`Runner.run(signal, inputs, from)`, `--durable`, `--resume`, and the same two fields on a request
body. A checkpoint names the node to *re-enter*, never the one that just finished.

**Phase S4 — `suspend` — landed.** The sixth `before` verdict, admitted at `toolCall.before` and
`node.before` and nowhere else. `RunSuspended` unwinds to the runner, which writes the checkpoint and
rethrows; the agent's bookmark carries the conversation, the pending call and the calls the round had
not reached. CLI `--answer`, HTTP `202` with the question, `suspended` on the SSE stream.

> **Found by running it: a `node` gate needs to see its own answer.** A `toolCall` suspension is
> never re-consulted — the bookmark replays the answer as the call's result. A `node` one is:
> resuming re-enters the node and every `before` hook runs again, so a gate with no way to tell
> "asked again, and here is what they said" from "asked for the first time" suspends forever. This
> surfaced in a smoke test, not in a unit test, because the first version of the test middleware
> tracked its own state in a module variable — which happens to work in one process and not across
> two. `MiddlewareContext.answered` closes it, and rides the wire for a remote middleware.
>
> **Diverged from the plan: the sink is installed whenever there is a session, not only when the run
> asked to be durable.** Under the plan's wording, `--session` without `--durable` plus a middleware
> that suspends produced a run stopped with no way back. Splitting the sink (always present) from
> `durable` (per-node writes) costs nothing and removes the trap. A run with no session at all still
> refuses to suspend, with an error saying why.

**Phase S5 — ergonomics and docs — landed.** `examples/approval-gate` as a worked middleware, a
`suspended` frame on the CLI's `--protocol` path to match the server's SSE event, the TUI seeded from
the store, and every `--chat` reference in the README, the website docs, the Docker guide and the
examples rewritten.

Dependencies as planned: S1 needed S0; S2 and S3 each needed S1; S4 needed S3; S5 needed S4.

## 9. Risks and non-goals

- **This is not a durable-execution engine.** Checkpoints are best-effort at boundaries heddle chooses.
  A tool that charges a card and then dies before its result is recorded **will be re-run on resume**.
  heddle cannot fix that from outside the tool; a tool wanting exactly-once needs its own idempotency
  key. The docs say this rather than implying otherwise.
- **Not multi-tenant.** §7.3. A session id is a bearer capability and the server has no authentication.
- **A store failure is a run failure.** A store that throws fails the run, for the same reason a
  middleware that throws does (`runner.ts:335`, `guarded`): swallowing it produces a run that reports
  success while its transcript silently did not record.
- **Transcript growth is unsolved in v1.** Every turn is sent to the model as history
  (`agent.ts:158`), so a long session gets expensive and eventually exceeds the context. Windowing or
  summarizing belongs in a transform or a middleware — not in the store, which should not be in the
  business of deciding what the model remembers.
- **No migration from `~/.heddle/conversations/`.** Nothing reads those files today (`loadSession` has
  no callers), so there is nothing to migrate. The release note says to delete the directory.
