---
name: create-heddle-agent
description: Create a new heddle agent from requirements — author the Weave flow, its tools and any plugin, then validate and actually run it against a stub model, no API key needed. Use when asked to create, add, scaffold, write, build, wire up, validate, smoke-test, debug or run a heddle agent, flow, spec, tool, transform, middleware or plugin.
---

# Create a heddle agent

Build one from the user's requirements: the Weave flow, the tools it calls,
and a plugin when the engine's builtin step verbs do not cover what was
asked for. An agent here is a **document plus executables** — a flow in YAML or
JSON (`weave.yaml` by convention), a directory of tool programs that speak JSON
over stdin/stdout, and optionally a plugin module. No SDK, no agent class to
subclass.

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

## The format in one screen

A Weave document says `weave: 1`, names itself, declares its `inputs`, `models`
and `tools`, then runs `steps` top to bottom into an `outcomes` map. Control
flow is list order plus `then:` jumps and `switch` branches; data flow is
`{{inputs.field}}` / `{{step.key}}` references, resolved and checked at load
time. There are no ids, no edge lists, and no `$component_ref`.

Each step has a `name` and exactly one **verb**:

| Verb | What it is | What it writes |
|---|---|---|
| `agent:` | a model with a tool loop (`model`, `prompt`, `tools`, optional `output`, `transforms`, `max_tool_rounds`) | `result` — or, with `output:` declared, exactly those keys, enforced JSON; with transforms, also `transform_status` |
| `llm:` | one completion, no tools (`model`, `prompt`) | `text` |
| `tool:` | a direct tool call, arguments in `with:` | the tool's declared `outputs` — checked, a contract |
| `switch:` | branching: one `{{ref}}` compared against `cases:` keys, `else:` required | nothing |
| `use:` | a plugin-defined step: component type plus `with:` config | what the plugin's manifest declares |

A document with a top-level `agent:` instead of `steps:` is sugar for a
one-step flow. Omit `outcomes:` and the document gets an implicit `done`
echoing the last step's outputs; declare them and each outcome's payload maps
names to literals or `{{references}}`. The final state is the payload plus
`outcome: <name>`.

Validation is strict and total, at load time: unknown keys are refused
everywhere except `meta` and a plugin component's own config (and the key names
`__proto__`, `constructor` and `prototype` are refused everywhere, even there);
every reference must name a producer that writes that key and runs on every
path to the consumer; every `then`/`case` target must exist and appear later in
the document; generation `params` admit only `temperature`, `max_tokens` and
`top_p`. `heddle validate` passing means the flow starts.

## Author from the template

`.claude/skills/create-heddle-agent/template/` is a working agent — flow with a
switch, two tools, one plugin transform — with the schema explained in comments.
Copy it and edit rather than writing from memory: the comments carry the rules
(what each verb writes, how references resolve) next to the lines they govern.

```bash
cp -r .claude/skills/create-heddle-agent/template my-agent
```

```
my-agent/
  spec.yaml            triage (agent + transform) -> switch -> two outcomes
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
prints — read that to confirm `{{reference}}` substitution and the tool schemas
the model saw.

`heddle init my-project` is the other starting point. It scaffolds a one-agent
`weave.yaml` with an echo tool and nothing else — fine for a trivial agent, no
switch, no plugin, no realistic tool.

## What goes where

Turning a requirement into document surface:

| The requirement | Where it goes |
|---|---|
| "it can search logs / read a file / call an API" | an entry in the document's `tools:` map, listed on the agent's `tools:` **and** an executable of the same name in `tools/` |
| a fixed step with no decision to make | a `tool:` step (runs a tool directly) or an `llm:` step (one completion, writes `text`) |
| "route to X when Y" | a `switch:` step on a `{{step.key}}` reference, with `cases:` and a required `else:` |
| "answer with these exact fields" | an `output:` schema on the agent step — the model is held to that JSON, and the step writes those keys |
| "redact / block / check every prompt or answer" | a plugin **transform** on the agent's `transforms:` (`- use: TheType` + config keys), `phase: pre`, `post` or `both` |
| a step the builtin verbs cannot express | a plugin **node**: a `use:` step whose `with:` is the component's config |
| "retry, rate-limit, require approval" | a plugin **middleware** — installed with `--plugin`, configured with `--plugin-config`, and never named in the document |
| a non-OpenAI model endpoint | a `models:` entry with `provider: openai-compatible`, `ollama` or `vllm` (with `url` as needed), or a plugin **provider** type |
| "stream events as AG-UI / some other wire format" | a plugin **encoder**, selected per request by `heddle-server`, not by the document |

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
| `--input JSON` | flow input; defaults to probe values built from the flow's `inputs` |
| `--script FILE` | exact model turns instead of auto-drive (below) |
| `--args FILE` | `{"tool_name": {…}}` real arguments for the stub to call tools with |
| `--final TEXT` | what the stub answers last; with an `output:` schema declared, make it the JSON the schema demands |
| `--transcript FILE` | where to write what the model was sent |
| `--max-tool-calls N` | ceiling on the stub's tool calls (default 8) |
| `--allow-placeholders` | downgrade an unsubstituted `{{ref}}` from FAIL to warning |
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

For an exact conversation — a specific branch, a tool called twice, a
particular final answer — script the turns. Each entry is one model call, in
order:

```json
[
  { "tool": "log_search", "arguments": { "pattern": "readiness probe", "limit": 2 } },
  { "tool": "runbook_lookup", "arguments": { "service": "search-indexer" } },
  { "content": "probes failing after payments-gw timeouts; roll back" }
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

`--chat` opens an interactive ink UI (a multi-turn session over the same flow);
each typed message is bound to the **first** key under the flow's `inputs`. It
paints without a TTY but there is no way to type into it from a script — use
the driver to exercise a flow, and `--chat` only when a human is watching.

## Gotchas

The old format's failure modes — dangling branches, declared outputs that were
fiction, placeholders reaching the model, `$component_ref` typos — are now
load-time errors or unrepresentable. What remains sharp is different in kind:
the validator refuses things you might expect to slide.

- **`else` is required on every switch.** There is no implicit default and no
  first-string-in-state fallback: a switch says where every unmatched value
  goes, or the document does not load.
- **Control flows forward only.** A `then:` or `case` target must appear
  *later* in the steps list (or be an outcome). A backward target is refused —
  `routes back to "x"` — because loops are reserved for a later format
  version. Retrying is a middleware's job, not an edge's.
- **Unknown keys are errors, everywhere.** Outside `meta` and a plugin
  component's own config, a misspelled key (`promt:`, `outputs:` on an agent)
  fails the load naming the key and the allowed set. There is no decoration to
  carry. (`__proto__`, `constructor` and `prototype` are refused as key names
  even inside plugin config.)
- **A tool step's declared outputs are a contract.** The runtime checks the
  executable's JSON against them: a declared key the tool did not write, or
  wrote with the wrong type, fails the step. Declare what the tool actually
  prints — every run, not just the happy path.
- **`output:` on an agent is strict, and its absence is too.** With a schema,
  the model is constrained to JSON and the step writes exactly those keys — an
  answer missing one fails the step, extras are dropped. Without one, the step
  writes `result` and nothing else: the old behavior of merging JSON keys out
  of the answer is gone, so a downstream `{{coder.summary}}` is a load error
  unless `output.summary` is declared.
- **Every `{{ref}}` must resolve on every path.** Referencing a step a switch
  can route around is refused at load: `a path reaches "x" without running
  "y"`. Either move the producer before the fork or route the reference-free
  path elsewhere.
- **Steps and outcomes share one namespace, and `inputs` is reserved.** A step
  and an outcome may not share a name (a branch target has to mean one thing),
  and nothing may be called `inputs`.
- **The agent's user message is the referenced values, keyed by reference.**
  heddle sends `{"inputs.service": "..."}` — the dotted refs the prompt makes —
  so a transform reading the input state (like the template's `SecretScrub
  require:`) must name keys that way too.
- **A tool file without the executable bit is reported as *missing*.**
  `heddle validate` says `missing executables for tools: log_search` while the
  file sits right there in the directory. `driver.mjs check` names the file and
  says `chmod +x`. Copying a tool from elsewhere is how you get here.
- **A shell tool must not pipe a heredoc into an interpreter.**
  `python3 - <<'PY'` makes the heredoc python's *stdin* — which is where the
  tool's JSON input is, so the input vanishes and the tool reports a parse error.
  Capture the script (`SCRIPT=$(cat <<'PY' … PY)`) and pass it with `-c`.
  `template/tools/log_search.sh` does this.
- **A plugin's `patterns` are JS regexes.** `(?i)` is not a JS inline flag;
  `new RegExp('(?i)…')` throws `Invalid group`. The plugin's own `validate` hook
  catches it at load time and `heddle validate` exits 1.
- **Plugins are never named in a spec**, only on the command line. A `use:` or
  transform names a component *type*; without its `--plugin` the load fails
  listing what is loaded. Middleware is the opposite: it may not be named in a
  document at all, only installed by whoever runs heddle.
- **A plugin transform is not a node.** A `use:` step naming a transform type
  fails with `…which a plugin provides as a transform rather than a node` —
  transforms go under an agent's `transforms:`.
- **The stub reaches the model through `OPENAI_BASE_URL`.** That works for
  `provider: openai` (no `url`), whose client falls back to the environment. A
  model that pins `url` — and `ollama`, whose default url is implicit — cannot
  be redirected: `driver.mjs check` warns, and a `run` would send real requests
  there. `examples/policies` also ships a stub provider type for specs that
  opt in; the driver does not need it.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `The OPENAI_API_KEY environment variable is missing or empty` | A real run with no key. Use `driver.mjs run`, which supplies a stub key and endpoint. |
| `missing executables for tools: x` | The tool name must equal the filename minus its extension, and the file must be executable — `chmod +x my-agent/tools/*`. |
| `failed to parse output JSON: …` | A tool printed something that is not one JSON object. Debug it alone with `driver.mjs tool`. Diagnostics belong on stderr. |
| `"x" references {{y.z}}, but "y" writes …` | The producer never writes that key: an agent without `output:` writes only `result`, an llm step writes `text`, a tool writes its declared outputs. Reference what is actually written, or declare it. |
| `step "x" routes to "y", which is not a step or an outcome` | A `then`/`case`/`else` target is misspelled, or names something you removed. Targets resolve against later steps and outcomes only. |
| `step "x" routes back to "y"` | Backward edges are refused in v1. Reorder the steps, or express the retry as middleware. |
| `"tool_x" declares the output "k" and did not write it` | The tool's declared `outputs` are enforced on tool steps. Make the executable print the key on every path, or stop declaring it. |
| `unknown key "…"` | A typo, or an old-format field (`component_type`, `metadata`, `id`). Only `meta` and plugin config carry free-form keys. |
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

All suites must pass on a clean tree; `pnpm typecheck` covers types. Then
re-run `driver.mjs run` against `template/spec.yaml` — one command exercises
the tool loop, a plugin transform, a switch and both outcomes.
