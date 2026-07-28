# heddle

A lightweight CLI framework for building and executing agentic workflows using the [Open Agent Specification](https://oracle.github.io/agent-spec/).

Define multi-step AI workflows as JSON, wire up LLM-powered agents and external tools, and run them from the command line.

## Features

- **Agent Spec compliant** - Implements the [Open Agent Specification](https://oracle.github.io/agent-spec/) format for portable workflow definitions
- **Graph-based execution** - Flows are compiled into directed graphs with control flow and data flow edges
- **LLM integration** - OpenAI-compatible LLM provider with tool-calling loop support
- **External tools** - Tools are standalone executables (shell scripts, Python, etc.) that communicate via JSON over stdin/stdout
- **Branching logic** - Conditional routing with `BranchingNode` for dynamic workflows
- **Validation** - Spec-level and graph-level validation catches errors before execution
- **Scaffolding** - `heddle init` generates a project template to get started quickly

## Packages

This repository is a pnpm workspace:

| Package | Description |
|---|---|
| [`@heddle/core`](packages/core) | The engine: spec parsing, graph compilation, node executors, runner, tools, LLM providers. No CLI dependencies — use it as a library. |
| [`@heddle/cli`](packages/cli) | The `heddle` command: run, validate, init, and interactive chat. |
| [`@heddle/server`](packages/server) | HTTP API over the same engine, with SSE streaming of execution events. **Unauthenticated — read its [README](packages/server/README.md) before binding it anywhere but localhost.** |

`vendor/agentspec` holds the Oracle Agent Spec TypeScript SDK, vendored because
it is not published to npm. See [vendor/agentspec/VENDOR.md](vendor/agentspec/VENDOR.md).

## Installation

```bash
# npm
npm install -g @heddle/cli

# Homebrew
brew install spichen/tap/heddle

# Docker — nothing to install
docker run --rm salahpichen/heddle --help
```

## Quick Start

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

Every provider needs a resolvable key, local ones included — see [LLM Configuration](#llm-configuration).

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
`ghcr.io/heddle-run/heddle` and `ghcr.io/heddle-run/heddle-server` — same
build, same manifest, no pull limit.

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

## CLI Reference

```
heddle [options] <command>

Options:
  --verbose                Enable verbose logging (may be placed before or
                           after the subcommand)

Commands:
  run <flow>               Run an Agent Spec flow (JSON or YAML)
    --tools-dir <dir>      Directory containing tool executables
    --input <json>         Input JSON object
    --chat                 Open an interactive chat session
    --plugin <module>      Plugin providing custom component types (repeatable)
    --safe                 Run tools inside an OS sandbox
    --sandbox <backend>    auto (default), bubblewrap, or seatbelt
    --allow-read <path>    Grant sandboxed tools read access (repeatable)
    --allow-write <path>   Grant sandboxed tools write access (repeatable)
    --allow-env <name>     Forward an env var into the sandbox (repeatable)
    --deny-net             Block network access for sandboxed tools

  validate <flow>          Validate a flow definition (JSON or YAML)
    --tools-dir <dir>      Directory containing tool executables
    --plugin <module>      Plugin providing custom component types (repeatable)

  init <project-name>      Scaffold a new heddle project
```

There is no `--version` flag yet; use `heddle --help` to check the install.

### Chat Mode

`--chat` opens a multi-turn session that re-runs the flow for each message, passing the
conversation so far to the agent. Transcripts are saved to
`~/.heddle/conversations/<session-id>.json`. Type `/exit` to quit.

Your message is bound to the first output declared on the flow's start node, falling back
to `query` when none is declared.

> **Note:** an in-flight run cannot be interrupted. `Ctrl+C` and `/exit` close the session,
> but a flow already executing runs until it finishes or hits the five-minute timeout.

> **Note:** `heddle validate` exits 0 even when graph or tool validation fails. Any error
> after schema validation is reported as `Graph validation skipped`, which also hides real
> problems such as a missing tool executable. Read its output rather than the exit code.

## How It Works

### Flow Definition

Flows are JSON or YAML files following the [Open Agent Specification](https://oracle.github.io/agent-spec/) format. A flow consists of **nodes** connected by **control flow** (execution order) and **data flow** (data passing) edges. Nodes and edges use `$component_ref` references — see `testdata/` for examples.

### Node Types

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
> environment, API keys included — a tool can read and write anything the invoking user can.
> Only put executables you trust in a tools directory, and take particular care with tools
> that execute commands or write files on a model's behalf, such as those in
> `examples/coding-agent/`. Pass [`--safe`](#safe-mode) to confine them instead.

### Safe Mode

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
| Working directory | read-only (opt in with `--allow-write`) |
| Tools directory | read-only — a tool cannot rewrite itself or its siblings |
| `$HOME` | a throwaway directory; the real one is unreachable, so `~/.ssh`, `~/.aws` and `~/.config` are not exposed |
| `$TMPDIR` | private scratch, discarded when the tool exits |
| `$HEDDLE_WORKSPACE` | writable, shared with the other tools in the same agent execution |
| Environment | only `PATH`, `HOME`, `TMPDIR`, locale, and anything named with `--allow-env` — so `OPENAI_API_KEY` and other secrets in heddle's own environment are not handed to tool code |
| Network | allowed by default; `--deny-net` turns it off |

Tools also get `HEDDLE_SANDBOX=1`, so one can detect confinement and adapt
rather than fail.

#### Per-agent sessions

Every `AgentNode` execution opens its own sandbox session. Each tool call is
still its own container, but all calls within one agent execution share a
single `$HEDDLE_WORKSPACE` directory — so an agent's tools can pass files to
each other, while a different agent's tools see a different, empty workspace.
The workspace is destroyed when the agent finishes. Tool calls made outside any
agent (a bare `ToolNode`) get a throwaway session of their own.

#### Limits

- Sandboxing applies to **tools**, not to plugins. Plugin modules are imported
  into the heddle process itself and run with full Node privileges; only the
  tools they invoke via `ctx.runTool` are confined.
- LLM calls are made by heddle, not by sandboxed code, so `--deny-net` does not
  affect them.
- On macOS the shared `/tmp` and `/var/tmp` stay writable, because `/bin/sh`
  writes here-documents to a hardcoded path there. Linux gets a private tmpfs
  and has no such hole.
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

Plugins are named on the command line, never inside a flow file — sharing a spec
can never cause code to be executed. A plugin node's branch names must be static,
because the graph is validated for reachability before anything runs.

A transform returning `reject` is what makes guardrails work. In the `pre` phase
heddle skips the model call entirely, so a blocked prompt costs nothing; the agent
returns `transform_status: "rejected"`, which a builtin `BranchingNode` can route on.

See [examples/guardrails](examples/guardrails) for a worked example: a `Processor`
transform used as both a pre- and post-processor on an agent.

### Execution Pipeline

```
JSON file → Parse → Validate spec → Compile graph → Validate graph → Run
```

1. **Parse** - Reads the Agent Spec JSON/YAML via the [agentspec SDK](https://oracle.github.io/agent-spec/) and resolves all node types
2. **Validate spec** - Zod schema validation via the SDK plus graph-level checks
3. **Compile** - Builds an executable graph with control and data flow edges
4. **Validate graph** - Ensures the graph is well-formed (reachable nodes, valid connections)
5. **Run** - Executes the graph from `StartNode` to `EndNode`, passing state between nodes

### Runner Defaults

These are fixed and not currently configurable from the CLI:

| Setting | Default |
|---------|---------|
| Max nodes executed per run | 50 |
| Total run timeout | 5 minutes |
| Max tool rounds (per agent) | 10 |
| Tool execution timeout | 30 seconds |

## Project Structure

```
src/
  cli/           Command handlers (run, validate, init)
  spec/          Agent Spec parser and validator
  graph/         Graph compilation and validation
  node/          Node executors (agent, llm, tool, branching)
  runner/        Flow execution engine with event system
  tool/          Tool registry (filesystem) and subprocess executor
  llm/           LLM provider interface and OpenAI implementation
  state/         Immutable state management
  scaffold/      Project template generation
examples/
  research-assistant/   Example flow with web_search and calculator tools
  guardrails/           Custom Processor transform used as a pre/post guardrail
testdata/               Test flow definitions and tool scripts
```

## LLM Configuration

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
> with no `api_key` fails at startup unless `OPENAI_API_KEY` is set — even for Ollama and vLLM,
> which ignore the key. Export any placeholder value for local servers.

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

MIT - See [LICENSE](LICENSE) for details.
