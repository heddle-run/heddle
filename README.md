# heddle

A runtime for agentic workflows written as **Weave** documents — heddle's own declarative format.

heddle needs no SDK. The workflow is a document, YAML or JSON (`weave.yaml` by convention), declaring its inputs, the steps that run in order, the model each agent calls and the tools they may use. heddle is what you point at it. One document runs two ways: `heddle run` on your machine, `heddle-server` over HTTP, with no rewrite between them.

## Features

| | |
|---|---|
| The Weave format | One strict document (`weave: 1`): steps run in order, `{{references}}` are the data wiring, and nothing unenforced is representable |
| Graph-based execution | Flows compile into directed graphs derived from step order, `then:` jumps and `switch` branches |
| LLM integration | An OpenAI-compatible provider, with the tool-calling loop built in |
| External tools | Standalone executables (shell, Python, anything) speaking JSON over stdin and stdout |
| Per-agent workspace | Each agent's tools share one writable directory and can reach each other by name; `--mount` puts your files in it |
| Branching logic | Conditional routing with `switch` steps — `cases` plus a required `else` |
| Validation | Structure, references and graph are all checked at load time: a document that validates is one that starts |
| Scaffolding | `heddle init` writes a flow and a working tool to run |

## Packages

This repository is a pnpm workspace:

| Package | Description |
|---|---|
| [`@heddle-run/core`](packages/core) | The engine: spec parsing, graph compilation, node executors, runner, tools, LLM providers. No CLI dependencies, so you can use it as a library. |
| [`@heddle-run/cli`](packages/cli) | The `heddle` command: run, validate, init, sessions, and interactive chat. |
| [`@heddle-run/server`](packages/server) | HTTP API over the same engine, with SSE streaming of execution events. **Unauthenticated. Read its [README](packages/server/README.md) before binding it anywhere but localhost.** |

## Installation

There is nothing to install. `npx` fetches the CLI and runs it — here running a
finished agent from the [library](https://heddle.run/library) by its bare name:

```bash
npx @heddle-run/cli run coding-agent
```

Or your own flow:

```bash
npx @heddle-run/cli run weave.yaml --tools-dir tools --input '{"query": "hello"}'
```

Every `heddle` in this README can be spelled `npx @heddle-run/cli`. Either way the
runtime stays outside your project: no dependency, no lockfile entry, nothing to
migrate when heddle changes its mind.

To keep it on the machine rather than fetching it each time:

```bash
npm install -g @heddle-run/cli
```

## Quick start

### 1. Scaffold a new project

```bash
heddle init my-project
```

This creates:

```
my-project/
  weave.yaml             - Weave flow definition
  tools/example_tool.sh  - Example tool script
```

### 2. Set an API key

The generated flow uses OpenAI, so export a key before running it:

```bash
export OPENAI_API_KEY=sk-...
```

Every provider needs a resolvable key, local ones included. See [LLM configuration](#llm-configuration).

### 3. Run a flow

```bash
heddle run my-project/weave.yaml \
  --tools-dir my-project/tools \
  --input '{"query": "hello"}'
```

The final state is printed to stdout as JSON; progress and errors go to stderr.

### 4. Validate a flow

```bash
heddle validate my-project/weave.yaml --tools-dir my-project/tools
```

## CLI reference

```
heddle [--verbose] <command>

Commands:
  run <flow>               Run a Weave flow (weave.yaml or JSON), or a
                           .heddle bundle
  validate <flow>          Validate a flow or bundle without running it
  bundle <flow>            Pack a flow and everything it runs with into one
                           shareable .heddle archive
  doctor <bundle>          Check whether this machine has what a bundle
                           declared it needs, without running it
  init <project-name>      Scaffold a new heddle project
  sessions                 Inspect kept conversations: ls, show <id>, rm <id>
```

The `run` flags you will reach for first:

| Flag | What it does |
|---|---|
| `--tools-dir <dir>` | Directory containing tool executables |
| `--input <json>` | Input JSON object for the flow's `inputs` |
| `--session [id]` | Keep this run in a conversation on disk; see [Sessions](#sessions) |
| `-i, --interactive` | Open the terminal chat UI; see [Interactive chat](#interactive-chat) |
| `--plugin <module>` | Load custom component types (repeatable); see [Plugins](#plugins) |
| `--format <name>` | Read the flow through a named input format instead of resolving it from the file extension; see [Input formats](#input-formats) |
| `--protocol <name>` | Render the run as JSON frames through an encoder instead of the human progress output |
| `--safe` | Run tools inside an OS sandbox; see [Safe mode](#safe-mode) |
| `--mount <src[:dest][:ro\|:rw]>` | Put a file or directory in every workspace; see [The workspace](#the-workspace) |

That is not all of them. `heddle run --help` prints the full list, covering sandbox
grants, workspace budgets, durable runs and plugin configuration, and every flag
is documented at
[heddle.run/docs/cli-reference](https://heddle.run/docs/cli-reference).

There is no `--version` flag yet; use `heddle --help` to check the install.

### Sessions

`--session` keeps a run in a conversation on disk and gives the agent the turns before it.
Each invocation is one turn:

```bash
heddle run flow.yaml --session support-42 --input '{"query":"where is my order?"}'
heddle run flow.yaml --session support-42 --input '{"query":"and the second one?"}'
```

With no id, a new session is created and its id printed to stderr. Sessions live in
`~/.heddle/sessions/<id>/`: a `meta.json`, a `turns.jsonl` appended to per turn, and a
`checkpoint.json` that exists only while a run is unfinished. `$HEDDLE_SESSION_DIR` or
`--session-dir` moves them.

The same mechanism works over HTTP: `POST /v1/sessions` issues an id, and `"session": "<id>"`
in a run body continues it. See [packages/server/README.md](packages/server/README.md).

### Durable runs and human in the loop

`--durable` writes the run down at every node boundary, so a process that dies can be picked
up with `--resume`. Independently of that, a middleware may **suspend** a run to wait on a
person. The run stops, the question is written into the session, and `--resume --answer` continues
it without re-running anything that already ran. See
[examples/approval-gate](examples/approval-gate/README.md).

### Interactive chat

`-i` opens a terminal chat UI. On its own the conversation lasts as long as the terminal does;
with `--session` it is kept, and a later `-i --session <id>` opens on the conversation so far.
Type `/exit` to quit.

Your message is bound to the first key declared under the flow's `inputs`, falling back
to `query` when none is declared.

> **Note:** an in-flight run cannot be interrupted. `Ctrl+C` and `/exit` close the session,
> but a flow already executing runs until it finishes or hits the five-minute timeout.

> **Note:** `heddle validate` exits 1 when a document does not parse, when a reference
> or branch target does not resolve, when the graph is invalid, and when the flow names a
> tool nothing provides. Validation is complete before anything starts: an unknown key, a
> `{{reference}}` nothing produces, or a case target that does not exist is a load-time
> error, not a mid-run death. A flow that validates is a flow that starts.

### Bundles

`heddle bundle` packs a flow and everything it runs with (tools, plugins, mounted
files, component settings, a default input) into one `.heddle` archive that runs
anywhere heddle is installed:

```bash
heddle bundle spec.yaml --tools-dir tools --plugin plugin.json \
  --mount skills --input '{"query":"hello"}' -o agent.heddle
```

Whoever receives it needs nothing else:

```bash
heddle run agent.heddle
```

The bundle is checked before it is written: the spec must parse, the graph must
hold, and every tool the flow names must be carried. A bundle that packs is a
bundle that runs. Flags still win at run time: `--input` overrides the recorded
default, and extra `--mount` or `--plugin` flags compose with what the bundle
carries. `heddle validate agent.heddle` inspects one without running it.

An agent that also needs something *heddle cannot ship* — a browser, `ffmpeg`, a
key — says so with `--requires`, and heddle checks it before the run starts,
reporting everything missing in one message instead of one failure at a time:

```bash
heddle doctor agent.heddle    # would this work here? exits non-zero if not
```

Every predicate only looks at the machine — a name on `$PATH`, a variable, a
path, a Node version. Nothing a bundle declares is ever executed, downloaded or
installed; a file that arrived in the mail does not get to run commands when you
open it.

A `.heddle` is a plain gzipped tar with a `heddle.json` manifest at its root, so
`tar -tzf agent.heddle` shows exactly what you were handed. No new dependency was
acquired to make that so. What a bundle deliberately does **not** carry: API keys
(a spec references them as `$ENV_VAR`, resolved on the machine that runs),
sandbox policy, and session state. Those belong to whoever runs it, not to
whoever built it. An in-process plugin (an importable module rather than a
`.json` manifest) cannot be bundled: its imports live on the author's machine,
so it is refused with a pointer at the manifest format.

## How it works

### Flow definition

Flows are **Weave** documents: YAML or JSON, `weave.yaml` by convention, starting
with the format version `weave: 1`. A document declares its `inputs`, its
`models` and `tools`, then an ordered list of `steps` ending in `outcomes`.
Control flow is the list order — plus `then:` jumps and `switch` branches — and
data flow is `{{inputs.field}}` / `{{step.key}}` references. There are no ids
and no edge lists; the wiring is implied by order and by the references
themselves, and every reference is checked at load time.

```yaml
weave: 1
name: notetaker
description: Transcribes a recording and writes a summary note.

inputs:
  recording: string

tools:
  transcribe:
    description: Transcribe an audio file.
    inputs: { path: string }
    outputs: { text: string }

agent: # a document with a top-level agent is sugar for a one-step flow
  model:
    provider: ollama
    model: qwen2.5:7b
  prompt: |
    Transcribe the recording at {{inputs.recording}} with the transcribe
    tool, then write a one-paragraph summary note.
  tools: [transcribe]
```

The full design, with worked multi-step examples, is in
[docs/weave-spec-design.md](docs/weave-spec-design.md).

### Input formats

JSON and YAML are not baked in: they are the two builtin **input formats**,
and a plugin can add more. An input format is the input mirror of an encoder.
Where an encoder renders the run's event stream into another wire format on the
way out, an input format reads a spec document in from another wire format. It
turns raw text into a Weave document (the `weave: 1` vocabulary above), and
everything past that point (validation, compilation, execution) never knows
which format the bytes arrived in. A format whose native schema is not Weave
translates to it in its `parse`.

A format is selected three ways, all naming the same registry:

- by **file extension**: `.json`, `.yaml`/`.yml`, or an extension a plugin's
  format claims. Anything unclaimed is read as JSON, as it always was.
- by **name**: `--format <name>` on `heddle run` and `heddle validate`.
- by **request**: a `"format"` field beside a string `"flow"` or a
  `"flowPath"` in `POST /v1/runs` and `/v1/validate`. `GET /v1/capabilities`
  lists what a server accepts under `formats`.

A plugin declares one in-process, beside its other components:

```js
export default {
  name: 'toml-format',
  version: '1.0.0',
  formats: [
    {
      name: 'toml',
      extensions: ['.toml'],
      parse: (text) => parseToml(text), // → a Weave document
    },
  ],
};
```

The builtin names and extensions are reserved, and two plugins claiming the
same name or extension are refused at load, because what a spec file means may
not depend on plugin load order.

`parse` does not have to be a decoder: a format for a *different spec* is a
translator into Weave's vocabulary. See
[examples/docker-agent](examples/docker-agent) for a worked one that reads a
[Docker agent file](https://docs.docker.com/ai/docker-agent/configuration/overview/)
and runs it as the flow it describes.

### Step verbs

Each step declares a `name` and exactly one verb:

| Verb | Description | Writes |
|------|-------------|--------|
| `agent:` | LLM-powered agent with a system prompt and optional tools. Runs an automatic tool-calling loop (up to 10 rounds). | `result` — or, with an `output:` schema declared, exactly those keys as enforced JSON |
| `llm:` | One completion through a model, no tools. The prompt is a template. | `text` |
| `tool:` | Executes an external tool directly, with arguments from `with:`. | the tool's declared `outputs`, checked against what the executable returned |
| `switch:` | Routes on one `{{reference}}`, compared against `cases:` keys; `else:` is required. | nothing |
| `use:` | A plugin-defined step; `with:` is the component's config. | what the plugin's manifest declares |

The flow's entry is its `inputs` declaration; its exits are the `outcomes` map,
each outcome naming the payload the run returns when it ends there.

### Tools

Tools are standalone executables placed in a directory. They receive JSON input on stdin and return JSON output on stdout:

```bash
#!/usr/bin/env bash
# tools/echo_tool.sh
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))")
echo "{\"response\": \"Echo: $MESSAGE\"}"
```

Tools are declared once in the document's top-level `tools:` map — name,
description, input and output schemas — and matched at runtime to an executable
in `--tools-dir` by name. A tool's name is its filename with the extension
stripped, so `fetch_api.py` is declared as `fetch_api`. An input without a
`default` is reported to the model as required; on a `tool:` step the declared
outputs are a contract, checked against what the executable actually returned.

> **Warning:** by default tools run as subprocesses of `heddle` and inherit its full
> environment, API keys included, so a tool can read and write anything the invoking user can.
> Only put executables you trust in a tools directory, and take particular care with tools
> that execute commands or write files on a model's behalf, such as those in
> `examples/coding-agent/`. Pass [`--safe`](#safe-mode) to confine them instead.

### The workspace

Every tool runs in a **workspace**: a directory of its own, which is also its
working directory and the place it writes. It is `$HEDDLE_WORKSPACE`, and a tool
starts inside it, so a relative path is a path in the workspace.

```
$HEDDLE_WORKSPACE/       # the tool's cwd, and its scratch
└── .heddle/bin/         # every tool, reachable by name
```

**One workspace per agent step execution**, shared by every tool call that agent
makes, so an agent's tools can pass files to each other (write a CSV in one
call, run a script over it in the next) while a different agent sees an empty
one. It is removed when the agent finishes. A bare `tool:` step gets a throwaway
of its own.

Every tool is also linked into `.heddle/bin`, which is on `PATH`, so a tool can
run a peer by the name the model uses for it. `--no-mount-tools` turns that off;
see the note under [Limits](#limits) for when you want to.

**Putting something in it.** `--mount` copies a file or directory into every
workspace before the run starts:

```bash
heddle run flow.yaml --tools-dir ./tools \
  --mount ./skills \
  --mount ./data/report.csv:input.csv \
  --mount ./notes:notes:rw
```

`<src>`, then optionally `:<dest>` (where it lands, relative to the workspace
root; the source's own name by default) and `:ro` or `:rw`. `ro` is the default
and is a copy: every node gets its own, and the original is untouched. `rw` is
shared: copied in when a node's scope opens, and the files that node changed
copied back when it closes. Deletions never propagate, last writer wins, and a
copy-back that fails is reported rather than raised.

A plugin can ship files the same way, by declaring `files` in its manifest
([reference](https://heddle.run/docs/plugins/manifest#files)).
[examples/skills-agent](examples/skills-agent) is one: two tools and a directory
of procedures, with no entry point and no process to start.

**Keeping it.** `--workspace <dir>` puts each node's workspace in
`<dir>/<node-name>` and leaves it there, so what the run produced is still
around afterwards.

<a id="workspace-not-confinement"></a>

> A workspace is not confinement. Without `--safe` nothing stops a tool writing
> elsewhere; what the workspace gives you is somewhere sensible for it to write
> by default, and somewhere its peers know to look. `$HEDDLE_SANDBOX` is what
> says whether anything is enforcing the edges.

### Safe mode

`--safe` runs every tool inside an OS sandbox:

```bash
heddle run weave.yaml --tools-dir ./tools --safe
```

Backends are picked automatically: **bubblewrap** on Linux, **Seatbelt**
(`sandbox-exec`) on macOS. Naming one explicitly with `--sandbox` fails rather
than falling back, so `--safe` never silently degrades into an unconfined run.

Inside the sandbox a tool gets:

| | |
|---|---|
| System directories | read-only |
| Launch directory | read-only; where you ran heddle, not where the tool starts (opt in with `--allow-write`) |
| Tools directory | read-only, so a tool cannot rewrite itself or its siblings |
| `$HOME` | a throwaway directory; the real one is unreachable, so `~/.ssh`, `~/.aws` and `~/.config` are not exposed |
| `$TMPDIR` | private scratch, discarded when the tool exits |
| `$HEDDLE_WORKSPACE` | writable, and the tool's working directory; see [The workspace](#the-workspace). `.heddle` inside it is read-only, so a tool cannot rewrite a peer |
| Environment | only `PATH`, `HOME`, `TMPDIR`, locale, and anything named with `--allow-env`, so `OPENAI_API_KEY` and other secrets in heddle's own environment are not handed to tool code |
| Network | allowed by default; `--deny-net` turns it off |

Tools also get `HEDDLE_SANDBOX=1`, so one can detect confinement and adapt
rather than fail.

#### Per-agent sessions

Every agent step execution opens its own sandbox session, over that step's own
[workspace](#the-workspace). Each tool call is still its own container, and what
`--safe` adds is enforcement: the workspace becomes the only place a tool *can*
write, and a `ro` mount inside it is refused a write outright.

#### Limits

- **A tool on `PATH` is a tool the model can reach without asking.** Every tool
  is in the workspace's `bin`, so a shell tool can exec a peer, and that call is
  dispatched by the tool, not by the model, so it passes no `toolCall`
  middleware and emits no `tool_call` event. An approval gate refuses the calls
  the model makes and not the calls a tool makes. This is not a hole in the
  sandbox: the program that ran is one you installed, inside the same
  confinement, with the same paths. What changed is who chose to run it.
  `--no-mount-tools` empties the workspace's `bin` if you need the narrower
  guarantee.
- Sandboxing applies to **tools**, not to plugins. Plugin modules are imported
  into the heddle process itself and run with full Node privileges; only the
  tools they invoke via `ctx.runTool` are confined.
- LLM calls are made by heddle, not by sandboxed code, so `--deny-net` does not
  affect them.
- On macOS the shared `/tmp` and `/var/tmp` stay writable, because `/bin/sh`
  writes here-documents to a hardcoded path there. Linux gets a private tmpfs
  and has no such hole.
- A confined tool gets a fixed `PATH` of system directories, not the one in your
  shell. An interpreter installed under `$HOME`, such as nvm, pyenv or asdf, is neither
  on that PATH nor readable, since `$HOME` is exactly what the sandbox hides. A
  tool that needs one wants `--allow-read` on the install root and has to put the
  `bin` directory on PATH itself; [examples/bash-agent](examples/bash-agent) is
  one that does.
- `--safe` requires Linux or macOS. On Linux, `bwrap` must be installed
  (`apt install bubblewrap`).

### Plugins

Custom component types beyond the builtin verbs come from plugins. A plugin is an
ES module that default-exports its component declarations. It can contribute
**transforms** (attached to an agent step's `transforms:`, running before or
after the model call) and **nodes** (a `use:` step placed in the flow):

```js
export default {
  name: 'heddle-plugin-guardrails',
  version: '1.0.0',
  transforms: [{
    componentType: 'Processor',
    phase: (c) => c.phase ?? 'pre',        // 'pre' | 'post' | 'both'
    createTransform: (c) => ({
      apply: (messages) => ({ action: 'pass' }),
      //   | { action: 'modify', messages }
      //   | { action: 'reject', reason }
    }),
  }],
};
```

```bash
heddle run weave.yaml --plugin ./plugin.js
```

One declaration drives both halves: it tells the validator what the component's
config may say (a `validate` hook, or a JSON Schema in a manifest plugin), and
it registers the executor that makes the component run. In the document, the
component appears as `use: <Type>` on a step (config under `with:`) or
`- use: <Type>` in a transforms list (config as the remaining keys). A document
can also pin the plugin version it was written against with a top-level
`requires:` map (`SecretScrub: '^1.0'`), checked at load.

Plugins are named on the command line, never inside a flow file, so sharing a spec
can never cause code to be executed.

A transform returning `reject` is what makes guardrails work. In the `pre` phase
heddle skips the model call entirely, so a blocked prompt costs nothing; the agent
writes `transform_status: "rejected"`, which a `switch` step can route on.

Nodes and transforms are both handed a `ctx` with the same five things:
`runTool`, `callModel`, `emitEvent`, `log`, and for a node `getWorkspace`.

`ctx.callModel({ messages })` is how a plugin thinks: an LLM judge, a semantic
router, a summarizer. **The plugin does not choose the model.** heddle calls the
`model` written on the plugin's own component in the spec, exactly as it
would an agent's, so the plugin ships no SDK, holds no credential, and cannot
send a request anywhere the flow does not say it will go:

```yaml
- name: judge
  use: LlmJudge
  with:
    rubric: "Is the answer supported by the sources?"
    model:
      provider: openai
      model: gpt-4o-mini
```

Anything a spec sets under a model's `params` — `temperature`, `max_tokens` and
`top_p` — is sent with the request, for agents and `llm` steps too.

See [examples/guardrails](examples/guardrails) for a worked example: a `Processor`
transform used as both a pre- and post-processor on an agent.

A plugin can also supply an **encoder**, which is not part of a flow at all: it
renders the run's event stream into another wire format, and the *request* selects
it rather than the spec or the operator. That is because two clients hitting one
flow can legitimately want different renderings, and neither the flow's author nor
whoever runs the server knows which. Encoders are reachable from both halves of
heddle: `--protocol <name>` on `heddle run` prints one JSON frame per line on
stdout instead of the human progress output, and
`POST /v1/runs?stream=true&protocol=<name>` selects the same rendering over
HTTP. See [examples/ag-ui](examples/ag-ui) for one that speaks
[AG-UI](https://docs.ag-ui.com), the protocol CopilotKit uses, run both ways.

The mirror on the input side is an **input format**, which reads a spec
document in from another wire format before any of this begins; see
[Input formats](#input-formats).

A plugin can also supply **middleware**, the one kind no document may name.
It is installed with `--plugin` by whoever runs heddle, takes its settings from
`--plugin-config`, and is consulted at the seams inside a run: a node that failed,
a tool the model asked for, a request about to go to the model. See
[examples/policies](examples/policies) for a retry policy, an approval gate and a
rate limit, each runnable without a credential.

### Execution pipeline

```
JSON/YAML → Parse → Resolve (refs + plugins) → Compile graph → Validate → Run
```

1. **Parse.** Reads the Weave document key by key, strictly: the `weave: 1` version, names, schemas, models, tools, steps. Unknown keys are refused everywhere except `meta` and plugin config (`packages/core/src/spec/parse.ts`).
2. **Resolve.** Checks the document against its own graph and the loaded plugins: every branch target lands, every `{{reference}}` names a producer that writes that key and runs on every path to its consumer, every `use:`/transform/provider type is one a plugin provides, every `requires` range is satisfied (`packages/core/src/spec/resolve.ts`).
3. **Compile graph.** Derives the executable graph from step order, `then:` jumps and `switch` cases — the edges are computed, not transcribed.
4. **Validate.** A backstop over the compiled graph: reachability and dead-end checks.
5. **Run.** Walks the graph from the flow's `inputs` to an outcome, each step's outputs namespaced under its name.

### Runner defaults

These are fixed and not currently configurable from the CLI:

| Setting | Default |
|---------|---------|
| Max nodes executed per run | 50 |
| Total run timeout | 5 minutes |
| Max tool rounds (per agent) | 10 |
| Tool execution timeout | 30 seconds |

## Examples

[examples/](examples/README.md) holds twelve worked examples, each with a
README, ordered from a first flow to plugins and middleware. Start with
[examples/research-assistant](examples/research-assistant/README.md).

## Library

[library/](library/README.md) is the other half of that: not examples of a
feature, but agents worth running. Each entry packs into one `.heddle` file that
runs anywhere heddle is installed.

| Entry | What it does |
|---|---|
| [local-notetaker](library/local-notetaker/README.md) | Records this machine's audio, transcribes it locally, and writes up the meeting — no bot joins the call. |
| [coding-agent](library/coding-agent/README.md) | Works on a codebase with OpenAI Codex CLI's orchestration: plan, shell, apply_patch, verify, repeat. |

```bash
node library/build.mjs coding-agent   # pack it
heddle run library/dist/coding-agent.heddle
```

Browsable at [heddle.run/library](https://heddle.run/library), and CI packs every
entry, so a listing there is a bundle that builds. A listing is also one command:
`heddle run coding-agent` fetches the library's published archive when no file
of that name is here.

## LLM configuration

Models are declared in the document's top-level `models` map and referenced by
name from `agent` and `llm` steps (an inline config object works anywhere a
name does). One shape, discriminated by `provider`:

```yaml
models:
  fast:
    provider: openai
    model: gpt-4o-mini
    api_key: $OPENAI_API_KEY
  local:
    provider: ollama
    model: qwen2.5:7b
    params: { temperature: 0 }
```

| `provider` | `url` | Description |
|-------------|-------|-------------|
| `openai` | optional | OpenAI API (uses `OPENAI_API_KEY` env var or `api_key` in spec) |
| `openai-compatible` | your endpoint | Any OpenAI-compatible endpoint |
| `vllm` | your endpoint | vLLM self-hosted endpoint |
| `ollama` | defaults to `http://localhost:11434/v1` | Ollama local endpoint; needs no key |

Any other `provider` value names a plugin-registered provider type. `params`
admits `temperature`, `max_tokens` and `top_p` — a parameter heddle would not
send is refused at load rather than carried as decoration.

An `api_key` value beginning with `$` is resolved from the environment, so `api_key: $MY_KEY`
reads `MY_KEY` and fails with a clear error when it is unset. On a terminal, `heddle run`
asks for the variables a spec names and the shell does not have before the run starts,
rather than failing at the first model call; the answer is hidden as you type and lives in
that process only. Scripts and CI are never asked, and `--no-ask-env` declines the question
on a terminal too.

> **Note:** apart from `ollama`, which needs no key, a key must be resolvable even for
> endpoints that ignore it: a `vllm` or `openai-compatible` config with no `api_key` fails
> at startup unless `OPENAI_API_KEY` is set. Export any placeholder value for local servers.

## Agent skill

If you write heddle agents with a coding agent, install the skill that teaches it
how: the flow schema, what belongs in a tool versus a plugin, and a driver that
runs a spec against a stub model so a new agent can be smoke-tested with no API
key.

```bash
npx skills add heddle-run/heddle --skill create-heddle-agent
```

It works in any project that can reach a `heddle` binary. Inside a clone of this
repo it is already there, at
[.claude/skills/create-heddle-agent](.claude/skills/create-heddle-agent/SKILL.md).

## Development

This repo uses [pnpm](https://pnpm.io/).

```bash
# Install dependencies
pnpm install

# Run in development mode
pnpm dev run weave.yaml

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build
pnpm build
```

## License

MIT. See [LICENSE](LICENSE) for details.
