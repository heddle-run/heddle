# specrun

A lightweight CLI framework for building and executing agentic workflows using the [Open Agent Specification](https://oracle.github.io/agent-spec/).

Define multi-step AI workflows as JSON, wire up LLM-powered agents and external tools, and run them from the command line.

## Features

- **Agent Spec compliant** - Implements the [Open Agent Specification](https://oracle.github.io/agent-spec/) format for portable workflow definitions
- **Graph-based execution** - Flows are compiled into directed graphs with control flow and data flow edges
- **LLM integration** - OpenAI-compatible LLM provider with tool-calling loop support
- **External tools** - Tools are standalone executables (shell scripts, Python, etc.) that communicate via JSON over stdin/stdout
- **Branching logic** - Conditional routing with `BranchingNode` for dynamic workflows
- **Validation** - Spec-level and graph-level validation catches errors before execution
- **Scaffolding** - `specrun init` generates a project template to get started quickly

## Installation

```bash
# npm
npm install -g @specrun/cli

# Homebrew
brew install spichen/tap/specrun
```

## Quick Start

### 1. Scaffold a new project

```bash
specrun init my-project
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
specrun run my-project/flow.json \
  --tools-dir my-project/tools \
  --input '{"query": "hello"}'
```

The final state is printed to stdout as JSON; progress and errors go to stderr.

### 4. Validate a flow

```bash
specrun validate my-project/flow.json --tools-dir my-project/tools
```

## CLI Reference

```
specrun [options] <command>

Options:
  --verbose                Enable verbose logging (may be placed before or
                           after the subcommand)

Commands:
  run <flow>               Run an Agent Spec flow (JSON or YAML)
    --tools-dir <dir>      Directory containing tool executables
    --input <json>         Input JSON object
    --chat                 Open an interactive chat session

  validate <flow>          Validate a flow definition (JSON or YAML)
    --tools-dir <dir>      Directory containing tool executables

  init <project-name>      Scaffold a new specrun project
```

There is no `--version` flag yet; use `specrun --help` to check the install.

### Chat Mode

`--chat` opens a multi-turn session that re-runs the flow for each message, passing the
conversation so far to the agent. Transcripts are saved to
`~/.specrun/conversations/<session-id>.json`. Type `/exit` to quit.

Your message is bound to the first output declared on the flow's start node, falling back
to `query` when none is declared.

> **Note:** an in-flight run cannot be interrupted. `Ctrl+C` and `/exit` close the session,
> but a flow already executing runs until it finishes or hits the five-minute timeout.

> **Note:** `specrun validate` exits 0 even when graph or tool validation fails. Any error
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

> **Warning:** tools run as subprocesses of `specrun` and inherit its full environment,
> API keys included. They are not sandboxed — a tool can read and write anything the invoking
> user can. Only put executables you trust in a tools directory, and take particular care with
> tools that execute commands or write files on a model's behalf, such as those in
> `examples/coding-agent/`.

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
