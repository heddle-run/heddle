---
name: create-heddle-agent
description: Create a new heddle agent from requirements — author the Agent Spec flow, its tools and any plugin, then validate and actually run it against a stub model, no API key needed. Use when asked to create, add, scaffold, write, build, wire up, validate, smoke-test, debug or run a heddle agent, flow, spec, tool, transform, middleware or plugin.
---

# Create a heddle agent

Build one from the user's requirements: the Agent Spec flow, the tools it calls,
and a plugin when the engine's builtin component types do not cover what was
asked for. An agent here is a **document plus executables** — a flow in YAML or
JSON, a directory of tool programs that speak JSON over stdin/stdout, and
optionally a plugin module. No SDK, no agent class to subclass.

Then prove it works, with **`.claude/skills/create-heddle-agent/driver.mjs`**. It
lints the spec, runs `heddle validate`, and — the part that matters — **runs the
flow against a stub model served on localhost**, so the agent you just wrote is
exercised end to end with no API key and no spend. Writing the document is half
the job; a spec nobody ran is a guess. Paths below are relative to the repo root.

## Get a CLI once

Inside a heddle checkout, build it:

```bash
pnpm install && pnpm build
```

The driver finds a CLI on its own, in this order: `$HEDDLE_BIN`, a build at
`packages/cli/dist/heddle.js`, `node_modules/.bin/heddle`, then `heddle` on
PATH. **Installed into another project** (`npx skills add heddle-run/heddle`), any
installed CLI works — `npm install -g @heddle-run/cli`, `brew install
spichen/tap/heddle`, or `HEDDLE_BIN="node /path/to/heddle/packages/cli/dist/heddle.js"`.
`npm install yaml` there too if you want the lint on a YAML spec; without it the
run still works and the spec-level checks are skipped with a note.

## Author from the template

`.claude/skills/create-heddle-agent/template/` is a working agent — flow with a
branch, two tools, one plugin transform — with the schema explained in comments.
Copy it and edit; do not write a flow from memory, the `$component_ref` wiring is
unforgiving.

```bash
cp -r .claude/skills/create-heddle-agent/template my-agent
```

```
my-agent/
  spec.yaml            start -> agent(+transform) -> branch -> two ends
  tools/               one executable per tool; name = filename minus extension
  plugin.mjs           a custom component type (a transform), loaded with --plugin
  fixtures/            data the sample tools read
  probe-args.json      realistic tool arguments for the stub (--args)
  script.json          an exact model conversation for the stub (--script)
```

Then work this loop until both commands pass:

```bash
node .claude/skills/create-heddle-agent/driver.mjs check my-agent/spec.yaml --tools-dir my-agent/tools --plugin ./my-agent/plugin.mjs
```

```bash
node .claude/skills/create-heddle-agent/driver.mjs run my-agent/spec.yaml --tools-dir my-agent/tools --plugin ./my-agent/plugin.mjs --input '{"alert":"checkout-api 502 rate 12%, upstream payments-gw timeout","service":"checkout-api"}'
```

`run` prints the nodes in the order they ran, every tool call with its arguments
and result, the final state, and a `PASS`/`FAIL` verdict (exit 1 on `FAIL`). It
also writes what the model was actually sent to a transcript file whose path it
prints — read that to confirm `{{placeholder}}` substitution and the tool schemas
the model saw.

`heddle init my-project` is the other starting point. It scaffolds a one-agent
`flow.json` with an echo tool and nothing else — fine for a trivial agent, no
branch, no plugin, no realistic tool.

## What goes where

Turning a requirement into components:

| The requirement | Where it goes |
|---|---|
| "it can search logs / read a file / call an API" | a `ServerTool` on the agent **and** an executable of the same name in `tools/` |
| a fixed step with no decision to make | a `ToolNode` (runs a tool) or `LlmNode` (runs a prompt template) in the graph |
| "route to X when Y" | a `BranchingNode` reading `branching_mapping_key` |
| "redact / block / check every prompt or answer" | a plugin **transform** on `Agent.transforms`, `phase: pre`, `post` or `both` |
| a step the builtin node types cannot express | a plugin **node**, placed in the graph |
| "retry, rate-limit, require approval" | a plugin **middleware** — installed with `--plugin`, configured with `--plugin-config`, and never named in the spec |
| a non-OpenAI model endpoint | the `llm_config` type (`OpenAiCompatibleConfig`, `OllamaConfig`, `VllmConfig` — each needs `url`), or a plugin **provider** |
| "stream events as AG-UI / some other wire format" | a plugin **encoder**, selected per request by `heddle-server`, not by the spec |

Richer worked examples live in `examples/`: `coding-agent` (eight tools,
sub-agent delegation), `bash-agent` (one shell tool, sandbox-aware),
`guardrails` (four transforms on one agent), `policies` (four middleware),
`ag-ui` (an encoder).

## Driver reference

```
node .claude/skills/create-heddle-agent/driver.mjs check <spec> [--tools-dir D] [--plugin M]...
node .claude/skills/create-heddle-agent/driver.mjs run   <spec> [--tools-dir D] [--plugin M]... [options]
node .claude/skills/create-heddle-agent/driver.mjs tool  <executable> [--input JSON]
```

| `run` option | |
|---|---|
| `--input JSON` | flow input; defaults to probe values built from the start node |
| `--script FILE` | exact model turns instead of auto-drive (below) |
| `--args FILE` | `{"tool_name": {…}}` real arguments for the stub to call tools with |
| `--final TEXT` | what the stub answers last; JSON text lands as extra state keys |
| `--transcript FILE` | where to write what the model was sent |
| `--max-tool-calls N` | ceiling on the stub's tool calls (default 8) |
| `--allow-placeholders` | downgrade an unsubstituted `{{var}}` from FAIL to warning |
| `--plugin-config T=JSON` | passed through to heddle, for middleware settings |
| `--timeout MS` | kill the run after this long (default 120000) |

**By default the stub calls every tool the agent offers, once each, then
answers.** That walks the whole tool-calling loop and proves each tool exists,
receives the schema's arguments, and returns parseable JSON. Its generated
arguments are placeholders (`probe:service`), so tools that do real work will
report errors on them — pass `--args` for realistic values:

```bash
node .claude/skills/create-heddle-agent/driver.mjs run my-agent/spec.yaml --tools-dir my-agent/tools --plugin ./my-agent/plugin.mjs --args my-agent/probe-args.json
```

For an exact conversation — a specific branch, a tool called twice, a JSON answer
— script the turns. Each entry is one model call, in order:

```json
[
  { "tool": "log_search", "arguments": { "pattern": "readiness probe", "limit": 2 } },
  { "tool": "runbook_lookup", "arguments": { "service": "search-indexer" } },
  { "content": "{\"result\":\"probes failing after payments-gw timeouts; roll back\"}" }
]
```

```bash
node .claude/skills/create-heddle-agent/driver.mjs run my-agent/spec.yaml --tools-dir my-agent/tools --plugin ./my-agent/plugin.mjs --script my-agent/script.json --input '{"alert":"probes failing","service":"checkout-api"}'
```

A tool on its own, before it is wired into anything:

```bash
node .claude/skills/create-heddle-agent/driver.mjs tool my-agent/tools/log_search.sh --input '{"pattern":"timeout","limit":3}'
```

## Run it for real

With a key, no stub, heddle's own output:

```bash
OPENAI_API_KEY=sk-… node packages/cli/dist/heddle.js run my-agent/spec.yaml --tools-dir my-agent/tools --plugin ./my-agent/plugin.mjs --input '{"alert":"checkout-api 502s","service":"checkout-api"}'
```

`--chat` opens an interactive ink UI (a multi-turn session over the same flow).
It paints without a TTY but there is no way to type into it from a script — use
the driver to exercise a flow, and `--chat` only when a human is watching.

## Gotchas

Every one of these was hit while building this skill.

- **`heddle validate` passes specs that die mid-run.** Verified twice: a
  `BranchingNode` whose `mapping` names a branch no control-flow edge leaves on
  validates clean, then the run ends with `no next node from "route"`; and a
  control-flow edge naming a branch its source never declares does the same.
  `driver.mjs check` catches both statically. The CLI also reports some
  post-schema failures as `Graph validation skipped: …` rather than failing
  (documented in the README) — the driver turns that line into a `FAIL` too.
- **A tool file without the executable bit is reported as *missing*.**
  `heddle validate` says `missing executables for tools: log_search` while the
  file sits right there in the directory. `driver.mjs check` names the file and
  says `chmod +x`. Copying a tool from elsewhere is how you get here.
- **An `LlmNode` writes `generated_text` and nothing else**, whatever its spec
  declares. A data edge reading a declared-but-fictional output validates clean
  and delivers nothing: `resolveInputs` skips a mapping whose source key is
  absent, silently. Verified — `heddle validate` said `Valid`, the run finished,
  and the end node's `summary` never existed.
- **An `AgentNode` writes `result`, plus the keys of its answer if the answer
  parses as JSON.** Declaring `summary` as an output does not create it; the model
  has to return `{"summary": …}`. With transforms installed the agent also writes
  `transform_status` (and on rejection `transform_reason`, `transform_name`,
  `transform_phase`).
- **A tool input with no `default` is reported to the model as required.** Give
  optional inputs a `default` or the model fills all of them.
- **A shell tool must not pipe a heredoc into an interpreter.**
  `python3 - <<'PY'` makes the heredoc python's *stdin* — which is where the
  tool's JSON input is, so the input vanishes and the tool reports a parse error.
  Capture the script (`SCRIPT=$(cat <<'PY' … PY)`) and pass it with `-c`.
  `template/tools/log_search.sh` does this.
- **A plugin's `patterns` are JS regexes.** `(?i)` is not a JS inline flag;
  `new RegExp('(?i)…')` throws `Invalid group`. The plugin's own `validate` hook
  catches it at load time and `heddle validate` exits 1.
- **A spec whose top level is an `Agent` cannot be run.** `heddle validate`
  accepts it; `heddle run` says `expected componentType 'Flow', got "Agent"`.
  Wrap the agent in a flow (`examples/math-homework-agent/spec.yaml` is one of
  these).
- **A `BranchingNode` reads `branching_mapping_key`** from its input, or the first
  string value in state if that key is absent. Route on a real signal by wiring a
  data edge into `branching_mapping_key`, and give the mapping a
  `DEFAULT_BRANCH` — an unmapped key falls through to a branch literally named
  `default`.
- **Plugins are never named in a spec**, only on the command line. A flow using a
  plugin component fails to parse without its `--plugin`. Middleware is the
  opposite: it may not be named in a spec at all, only installed by whoever runs
  heddle.
- **A plugin transform is not a node.** Putting a transform component type in
  `nodes` fails with `…which a plugin provides as a transform rather than a node`.
- **The stub reaches the model through `OPENAI_BASE_URL`.** That works because
  `OpenAiConfig` never sets a base URL on the SDK client. An `llm_config` that
  pins `url` (`OpenAiCompatibleConfig`, `OllamaConfig`, `VllmConfig`) cannot be
  redirected — `driver.mjs check` warns, and a `run` would send real requests
  there. `examples/policies` also ships a `StubModelConfig` provider for specs
  that opt in; the driver does not need it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `The OPENAI_API_KEY environment variable is missing or empty` | A real run with no key. Use `driver.mjs run`, which supplies a stub key and endpoint. |
| `missing executables for tools: x` | The tool name must equal the filename minus its extension, and the file must be executable — `chmod +x my-agent/tools/*`. |
| `failed to parse output JSON: …` | A tool printed something that is not one JSON object. Debug it alone with `driver.mjs tool`. Diagnostics belong on stderr. |
| `a prompt reached the model still containing {{service}}` | Nothing in the node's state had that key: no data edge delivers it, or the title is misspelled. The driver fails the run for this. |
| `EndNode "end" declares input "x" but the run ended without it` | The key was never written — usually an `LlmNode`/`AgentNode` output that exists only on paper. |
| `no next node from "route" (branch="…")` | The branch has no outgoing control-flow edge. `driver.mjs check` catches it before the run. |
| `no heddle CLI found. Looked for a build at …` | In a checkout: `pnpm install && pnpm build`. Elsewhere: install the CLI or set `HEDDLE_BIN`. The message lists every place it looked. |
| `the "yaml" package did not resolve …` | Only the lint and derived probe values are lost; the run is unaffected. `npm install yaml`, or use a JSON spec. |

## Changed the engine, not the agent

Only inside a heddle checkout:

```bash
pnpm test
```

```bash
pnpm --filter @heddle-run/core test
```

On a clean tree that is 637 core, 27 cli and 152 server tests, all passing;
`pnpm typecheck` covers types. Then re-run `driver.mjs run` against
`template/spec.yaml` — one command exercises the tool loop, a plugin transform, a
branch and both end nodes.
