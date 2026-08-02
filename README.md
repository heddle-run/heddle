# heddle

A runtime for agentic workflows written as [Open Agent Specification](https://oracle.github.io/agent-spec/) documents.

heddle needs no SDK. The workflow is a document, YAML or JSON, naming nodes, the edges between them, the model each agent calls and the tools they may use. heddle is what you point at it. One document runs two ways: `heddle run` on your machine, `heddle-server` over HTTP, with no rewrite between them.

## Features

| | |
|---|---|
| Agent Spec compliant | Implements the [Open Agent Specification](https://oracle.github.io/agent-spec/), so a flow is portable off heddle |
| Graph-based execution | Flows compile into directed graphs with control flow and data flow edges |
| LLM integration | An OpenAI-compatible provider, with the tool-calling loop built in |
| External tools | Standalone executables (shell, Python, anything) speaking JSON over stdin and stdout |
| Per-agent workspace | Each agent's tools share one writable directory and can reach each other by name; `--mount` puts your files in it |
| Branching logic | Conditional routing with `BranchingNode` |
| Validation | Spec-level and graph-level checks catch errors before execution |
| Scaffolding | `heddle init` writes a flow and a working tool to run |

## Packages

This repository is a pnpm workspace:

| Package | Description |
|---|---|
| [`@heddle/core`](packages/core) | The engine: spec parsing, graph compilation, node executors, runner, tools, LLM providers. No CLI dependencies, so you can use it as a library. |
| [`@heddle/cli`](packages/cli) | The `heddle` command: run, validate, init, sessions, and interactive chat. |
| [`@heddle/server`](packages/server) | HTTP API over the same engine, with SSE streaming of execution events. **Unauthenticated. Read its [README](packages/server/README.md) before binding it anywhere but localhost.** |

`vendor/agentspec` holds the Oracle Agent Spec TypeScript SDK, vendored because
it is not published to npm. See [vendor/agentspec/VENDOR.md](vendor/agentspec/VENDOR.md).

## Installation

There is nothing to install. `npx` fetches the CLI and runs it:

```bash
npx @heddle/cli run flow.json --tools-dir tools --input '{"query": "hello"}'
```

Every `heddle` in this README can be spelled `npx @heddle/cli`. Either way the
runtime stays outside your project: no dependency, no lockfile entry, nothing to
migrate when heddle changes its mind.

To keep it on the machine rather than fetching it each time:

```bash
# npm
npm install -g @heddle/cli

# Homebrew
brew install spichen/tap/heddle

# Docker, with no Node at all
docker run --rm salahpichen/heddle --help
```

## Quick start

### 1. Scaffold a new project

```bash
heddle init my-project
```

This creates:

```
my-project/
  flow.json              - Agent Spec flow definition
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
heddle run my-project/flow.json \
  --tools-dir my-project/tools \
  --input '{"query": "hello"}'
```

The final state is printed to stdout as JSON; progress and errors go to stderr.

### 4. Validate a flow

```bash
heddle validate my-project/flow.json --tools-dir my-project/tools
```

## Docker

Two images, `linux/amd64` and `linux/arm64`:

| Image | Contains |
|---|---|
| [`salahpichen/heddle`](https://hub.docker.com/r/salahpichen/heddle) | the CLI |
| [`salahpichen/heddle-server`](https://hub.docker.com/r/salahpichen/heddle-server) | the HTTP API |

Both are also on GitHub Container Registry, as
`ghcr.io/heddle-run/heddle` and `ghcr.io/heddle-run/heddle-server`: same
build, same digests, and no per-IP cap on anonymous pulls to trip over in CI.

`/work` is the CLI image's working directory, so a mounted project keeps the
paths you would have typed anyway:

```bash
docker run --rm -e OPENAI_API_KEY -v "$PWD:/work" \
  salahpichen/heddle run flow.json --tools-dir tools --input '{"query": "hello"}'
```

The examples ship in the image, so there is something to run before you have
written anything:

```bash
docker run --rm -e OPENAI_API_KEY salahpichen/heddle run \
  /opt/heddle/examples/research-assistant/flow.json \
  --tools-dir /opt/heddle/examples/research-assistant/tools \
  --input '{"query": "what is a heddle"}'
```

See [docs/docker.md](docs/docker.md) for chat mode, local models, file
ownership, `--safe` inside a container, and running the server image.

## CLI reference

```
heddle [--verbose] <command>

Commands:
  run <flow>               Run an Agent Spec flow (JSON or YAML), or a
                           .heddle bundle
  validate <flow>          Validate a flow or bundle without running it
  bundle <flow>            Pack a flow and everything it runs with into one
                           shareable .heddle archive
  init <project-name>      Scaffold a new heddle project
  sessions                 Inspect kept conversations: ls, show <id>, rm <id>
```

The `run` flags you will reach for first:

| Flag | What it does |
|---|---|
| `--tools-dir <dir>` | Directory containing tool executables |
| `--input <json>` | Input JSON object for the flow's start node |
| `--session [id]` | Keep this run in a conversation on disk; see [Sessions](#sessions) |
| `-i, --interactive` | Open the terminal chat UI; see [Interactive chat](#interactive-chat) |
| `--plugin <module>` | Load custom component types (repeatable); see [Plugins](#plugins) |
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

Your message is bound to the first output declared on the flow's start node, falling back
to `query` when none is declared.

> **Note:** an in-flight run cannot be interrupted. `Ctrl+C` and `/exit` close the session,
> but a flow already executing runs until it finishes or hits the five-minute timeout.

> **Note:** `heddle validate` exits 1 when a spec does not parse, when its graph is
> invalid, and when the flow names a tool nothing provides. The one thing it tolerates is a
> graph it could not compile at all, reported as `Graph validation skipped` with the reason
> and exit 0. The skip is there so a check that could not run is not mistaken for a fault.
> Read the output as well as the status.

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

Flows are JSON or YAML files following the [Open Agent Specification](https://oracle.github.io/agent-spec/) format. A flow consists of **nodes** connected by **control flow** (execution order) and **data flow** (data passing) edges. Nodes and edges use `$component_ref` references; see `testdata/` for examples.

### Node types

| Node | Description |
|------|-------------|
| `StartNode` | Entry point of the flow. Defines expected inputs. |
| `EndNode` | Exit point. Supports named branches for multi-branch flows. |
| `AgentNode` | LLM-powered agent with a system prompt and optional tools. Runs an automatic tool-calling loop (up to 10 rounds). |
| `LlmNode` | Runs a prompt template through an LLM. Supports `{{variable}}` substitution. |
| `ToolNode` | Executes an external tool directly within the flow. |
| `BranchingNode` | Routes execution to different branches based on an input-to-branch mapping. |

### Tools

Tools are standalone executables placed in a directory. They receive JSON input on stdin and return JSON output on stdout:

```bash
#!/usr/bin/env bash
# tools/echo_tool.sh
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))")
echo "{\"response\": \"Echo: $MESSAGE\"}"
```

Tools are declared inline as `ServerTool` components in the flow, and matched at runtime to an
executable in `--tools-dir` by name. A tool's name is its filename with the extension stripped,
so `fetch_api.py` is declared as `fetch_api`.

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

**One workspace per `AgentNode` execution**, shared by every tool call that agent
makes, so an agent's tools can pass files to each other (write a CSV in one
call, run a script over it in the next) while a different agent sees an empty
one. It is removed when the agent finishes. A bare `ToolNode` gets a throwaway
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
heddle run flow.json --tools-dir ./tools --safe
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

Every `AgentNode` execution opens its own sandbox session, over that node's own
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

Custom component types beyond the builtin list come from plugins. A plugin is an
ES module that default-exports its component declarations. It can contribute
**transforms** (attached to `Agent.transforms`, running before or after the model
call), **nodes** (placed in a flow's graph), or plain **components** nested inside
either:

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
heddle run flow.json --plugin ./plugin.js
```

One declaration drives both halves: it becomes an [Agent Spec deserialization
plugin](https://oracle.github.io/agent-spec/26.1.2/howtoguides/howto_plugin.html)
so the custom `component_type` parses and round-trips, and it registers the
executor that makes the component run. Agent Spec's own plugin system covers only
the serialization half.

Plugins are named on the command line, never inside a flow file, so sharing a spec
can never cause code to be executed. A plugin node's branch names must be static,
because the graph is validated for reachability before anything runs.

A transform returning `reject` is what makes guardrails work. In the `pre` phase
heddle skips the model call entirely, so a blocked prompt costs nothing; the agent
returns `transform_status: "rejected"`, which a builtin `BranchingNode` can route on.

Nodes and transforms are both handed a `ctx` with the same five things:
`runTool`, `callModel`, `emitEvent`, `log`, and for a node `getWorkspace`.

`ctx.callModel({ messages })` is how a plugin thinks: an LLM judge, a semantic
router, a summarizer. **The plugin does not choose the model.** heddle calls the
`llm_config` written on the plugin's own component in the spec, exactly as it
would an agent's, so the plugin ships no SDK, holds no credential, and cannot
send a request anywhere the flow does not say it will go:

```yaml
- component_type: LlmJudge
  name: judge
  rubric: "Is the answer supported by the sources?"
  llm_config:
    component_type: OpenAiConfig
    model_id: gpt-4o-mini
```

Anything a spec sets under `default_generation_parameters`, such as `temperature`,
`max_tokens` and `top_p`, is sent with the request, for agents and `LlmNode`s too.

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

A plugin can also supply **middleware**, the one kind no document may name.
It is installed with `--plugin` by whoever runs heddle, takes its settings from
`--plugin-config`, and is consulted at the seams inside a run: a node that failed,
a tool the model asked for, a request about to go to the model. See
[examples/policies](examples/policies) for a retry policy, an approval gate and a
rate limit, each runnable without a credential.

### Execution pipeline

```
JSON file → Parse → Validate spec → Compile graph → Validate graph → Run
```

1. **Parse.** Reads the Agent Spec JSON or YAML through the [agentspec SDK](https://oracle.github.io/agent-spec/) and resolves every node type.
2. **Validate spec.** Zod schema validation through the SDK.
3. **Compile.** Builds an executable graph with control and data flow edges.
4. **Validate graph.** Checks that nodes are reachable and connections are well-formed.
5. **Run.** Walks the graph from `StartNode` to `EndNode`, passing state between nodes.

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

## LLM configuration

LLM providers are configured in the `llm_config` field of an `Agent` or an `LlmNode`.
Every config needs a `name` and a `model_id`. Supported types:

| Config Type | `url` | Description |
|-------------|-------|-------------|
| `OpenAiConfig` | not accepted | OpenAI API (uses `OPENAI_API_KEY` env var or `api_key` in spec) |
| `OpenAiCompatibleConfig` | required | Any OpenAI-compatible endpoint |
| `VllmConfig` | required | vLLM self-hosted endpoint |
| `OllamaConfig` | required | Ollama local endpoint |

An `api_key` value beginning with `$` is resolved from the environment, so `api_key: $MY_KEY`
reads `MY_KEY` and fails with a clear error when it is unset.

> **Note:** an API key must be resolvable for every provider, including local ones. A config
> with no `api_key` fails at startup unless `OPENAI_API_KEY` is set, even for Ollama and vLLM,
> which ignore the key. Export any placeholder value for local servers.

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
pnpm dev run flow.json

# Run tests
pnpm test

# Type check
pnpm typecheck

# Build
pnpm build
```

## License

MIT. See [LICENSE](LICENSE) for details.
