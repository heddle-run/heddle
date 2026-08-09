# Coding agent

The agent orchestration inside [OpenAI's Codex CLI](https://github.com/openai/codex),
ported to a heddle flow. Not "inspired by": the session opens with Codex's
context bundle, the model holds Codex's tools with Codex's schemas and reads
Codex's base instructions, the approval policies are Codex's policies, and the
answers the tools give are formatted byte-for-byte the way Codex formats them.
Ported from the `codex-rs` source at commit `3aae5d8` (Apache-2.0).

Give it a task against the bundled sample project — a pricing module with one
failing test — or mount your own repository and give it a task against that.

## The map

Codex is a Rust harness with an engine-managed loop; heddle is a declarative
runtime. Every piece of Codex's orchestration lands in the heddle idiom that
owns that job:

| In Codex | Here |
|---|---|
| The turn loop: model → tool calls → outputs → model, until a plain answer | heddle's `AgentNode` loop, which works the same way. Codex has no round cap; heddle's default is 10 model responses per node — pass `--max-tool-rounds 24` for real tasks, and the prompt tells the model to batch |
| Base instructions (`models-manager/prompt.md`) | The agent's `system_prompt`, ported near-verbatim, plus Codex's `apply_patch` instructions appendix |
| Session prefix: AGENTS.md fragment + `<environment_context>` + permissions instructions | The `context` ToolNode runs `environment_context` before the agent; its three fragments arrive with the first message, in Codex's exact wrapper formats |
| `shell_command` — a shell string, `workdir`, `timeout_ms` (default 10000, timeout ⇒ exit 124), `sandbox_permissions` / `justification` / `prefix_rule` | `tools/shell_command.py`, same schema, same `Exit code: / Wall time: / Output:` block, same middle-truncation at 10 000 bytes |
| `apply_patch` — the `*** Begin Patch` grammar: Add / Delete / Update File, `*** Move to:`, `@@` anchors, `*** End of File` | `tools/apply_patch.py`, the full grammar with Codex's three matching passes (exact, then ignoring trailing whitespace, then surrounding), answering `Success. Updated the following files:` |
| `apply_patch` invoked *through the shell* (heredoc or two-word form) is intercepted, never executed by bash | `shell_command.py` does the same interception and delegates to the patch engine |
| `update_plan` — steps with `pending` / `in_progress` / `completed`, at most one in progress | `tools/update_plan.py`, answering `Plan updated` |
| Approval policy (`untrusted`, `on-request`, `never`; `on-failure` is an alias of `on-request`, as in Codex) with the known-safe command list and dangerous-command checks | The `CodexApprovals` middleware in `plugin.mjs`, consulted before every tool call the model asks for |
| Sandbox (`workspace-write` seatbelt/landlock) | heddle's own `--safe` OS sandbox; the permissions prose announces the posture you configure |
| Auto-compaction near the context window | The `CodexContextWindow` middleware — Codex's *token-budget* compaction mode: older assistant/tool rounds dropped whole, a bridge message marks the cut, user messages survive |

## Run it

Pack and run the demo (the sample project travels inside the bundle; the run
works on a copy, so the sample is pristine every time):

```bash
node library/build.mjs coding-agent
```

```bash
heddle run library/dist/coding-agent.heddle
```

At a terminal that opens a conversation, the way Codex itself opens one: type
a task, watch the loop run, type the next thing. The bundle records
`interactive`, so `heddle run` at a TTY goes straight to the chat UI — add
`--session` if you want the conversation kept and resumable. Piped, scripted,
or given an explicit `--input`, the same bundle runs once instead, so CI never
blocks on a UI; the recorded default task asks it to find and fix the failing
test. Watch it do the Codex loop either way: `update_plan`, run the tests,
read the failure, one `apply_patch`, tests again, a short final answer.

From source while editing:

```bash
heddle run library/coding-agent/spec.yaml \
  --tools-dir library/coding-agent/tools \
  --plugin ./library/coding-agent/plugin.json \
  --mount library/coding-agent/workspace:.:ro \
  --input '{"task":"Run the tests and fix the failing one with apply_patch.","cwd":".","approval_policy":"on-request","sandbox_mode":"workspace-write"}'
```

And the no-key, no-spend proof that the whole loop works, which CI-minded
people should run after any edit:

```bash
node .claude/skills/create-heddle-agent/driver.mjs check library/coding-agent/spec.yaml --tools-dir library/coding-agent/tools --plugin ./library/coding-agent/plugin.json
```

```bash
node .claude/skills/create-heddle-agent/driver.mjs run library/coding-agent/spec.yaml --tools-dir library/coding-agent/tools --plugin ./library/coding-agent/plugin.json --script library/coding-agent/script.json --input '{"task":"One of the pricing tests fails. Find the bug, fix it with apply_patch, and prove the fix by re-running the tests.","cwd":".","approval_policy":"on-request","sandbox_mode":"workspace-write"}'
```

## On your own repository

Mount the repository beside the sample and point `cwd` at it:

```bash
heddle run library/dist/coding-agent.heddle \
  --mount ~/code/myrepo:myrepo:rw \
  --max-tool-rounds 24 \
  --input '{"task":"Fix the flaky retry test in tests/util.","cwd":"myrepo","approval_policy":"on-request","sandbox_mode":"workspace-write"}'
```

`--max-tool-rounds` matters on real work: the default budget is 10 model
responses per agent node, and an agent that explores before it edits can spend
that before it gets to say what it did. Codex itself has no such cap.

The run copies the repository into its workspace, works on the copy, and on a
`:rw` mount copies changed and new files back when it ends. Two things to
know, both by design:

- **Deletions do not copy back.** A `*** Delete File:` lands in the workspace
  copy but never deletes on your disk; the final answer will say what was
  removed so you can do it yourself.
- `cwd` names the directory the agent treats as the project: AGENTS.md
  discovery starts from its nearest `.git` root, and the
  `<environment_context>` announces it, so the model works there rather than
  in the workspace root where the sample sits.

## Approvals, the heddle way

`--plugin-config CodexApprovals=…` chooses the policy; the bundle's default is
Codex's default, `on-request`. Under it, ordinary commands run inside whatever
sandbox you gave the run, and the model asks — with
`sandbox_permissions: "require_escalated"` and a `justification` — when it
believes a command needs more, exactly as Codex's permissions instructions
tell it to.

Codex asks you inline; heddle stops the run and writes the question into the
session. That is the one seam where the port is heddle-shaped rather than
Codex-shaped, and the handshake is:

```bash
heddle run library/dist/coding-agent.heddle --durable \
  --plugin-config CodexApprovals='{"approval_policy":"untrusted"}'
```

```
"CodexApprovals" suspended the run before "shell_command" and is waiting on a human.
  question: Allow this command? (untrusted: only known-safe reads run unasked)
  command:  python3 -m unittest discover -s tests -v
```

Decline by resuming with `--answer '{"approved":false}'` — the model reads the
refusal as the call's result and finds another way, which is precisely what
Codex's model does when you deny an approval. Approve by resuming with the
answer *and* a rule that lets the re-issued call through:

```bash
heddle run library/dist/coding-agent.heddle --resume <session-id> \
  --answer '{"approved":true}' \
  --plugin-config CodexApprovals='{"approval_policy":"untrusted","rules":[{"prefix":["python3","-m","unittest"],"decision":"allow"}]}'
```

The prompt teaches the model that `{"approved": true}` means "re-issue the
identical call"; the rule is what lets that second ask run. Rules are Codex's
execpolicy prefix rules: `allow`, `prompt`, or `forbidden` per argv prefix,
and the model's own `prefix_rule` suggestions surface in the question so you
can copy one in. The known-safe list (`ls`, `cat`, `rg`, `sed -n`, read-only
`git`, and friends) and the dangerous-command checks (`rm -f`…, `sudo`)
are ported from Codex's `is_safe_command.rs` and `is_dangerous_command.rs`.

Run `--safe` to put the tools in an OS sandbox — that is the part of Codex's
posture heddle already owned:

```bash
heddle run library/dist/coding-agent.heddle --safe
```

## What it will not do

- **No PTY sessions.** Codex's newest models get `exec_command`/`write_stdin`
  — a persistent interactive terminal. A heddle tool is one process per call,
  so this port ships Codex's `shell_command` (its own fallback shell tool) and
  each call is a fresh shell.
- **No mid-turn steering.** Codex queues a message you type mid-task into the
  next model request. A heddle run takes its input up front; `--chat` gives
  you turns *between* runs instead.
- **No summarizing compaction.** Codex's richest compaction asks the model to
  write a handoff summary. A middleware cannot call the model, so the port
  ships Codex's token-budget mode (drop old rounds, bridge message). The
  round ceiling (`--max-tool-rounds`, default 10) usually arrives before the
  context window does anyway.
- **No `view_image`, no `web_search`, no MCP tools** — multimodal attachment
  and hosted search have no heddle equivalent to port onto, and MCP is not
  part of this entry.
- **No review mode.** `codex review` spawns an isolated child session with a
  reviewer rubric. Expressible as a second flow, but not part of this entry.

## Files

```
spec.yaml       start -> context -> coder -> end; the Codex prompt and tool schemas
tools/          shell_command, apply_patch, update_plan, environment_context
plugin.json     CodexApprovals + CodexContextWindow manifest
plugin.mjs      the two middleware
workspace/      the sample project (AGENTS.md, pricing/, tests/)
script.json     the scripted stub conversation the driver replays
probe-args.json realistic arguments for the driver's probe mode
```
