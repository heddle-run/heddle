# @heddle/cli

The `heddle` command: a runtime for agentic workflows written as
[Open Agent Specification](https://oracle.github.io/agent-spec/) documents.

heddle needs no SDK. The workflow is a document — YAML or JSON — naming nodes,
the edges between them, the model each agent calls and the tools they may use.
heddle is what you point at it.

## Run it without installing it

```bash
npx @heddle/cli run flow.json --tools-dir tools --input '{"query": "hello"}'
```

That is the intended shape, not a shortcut: the runtime stays outside your
project, so nothing enters your dependency tree or your lockfile.

To keep it on the machine instead:

```bash
npm install -g @heddle/cli
```

Then the command is `heddle`. Homebrew (`brew install spichen/tap/heddle`) and
Docker (`docker run --rm salahpichen/heddle --help`) install the same CLI; the
Docker image needs no Node at all.

Node.js 18 or newer.

## Start from a scaffold

```bash
npx @heddle/cli init my-project
```

```
my-project/
  flow.json              - Agent Spec flow definition
  tools/example_tool.sh  - Example tool script
```

The generated flow calls OpenAI, so give it a key — every provider needs a
resolvable one, local models included:

```bash
export OPENAI_API_KEY=sk-...
```

```bash
npx @heddle/cli run my-project/flow.json \
  --tools-dir my-project/tools \
  --input '{"query": "hello"}'
```

The final state is printed to stdout as JSON; progress and errors go to stderr.

## Commands

| | |
|---|---|
| `run <flow>` | Run a flow, or a `.heddle` bundle. `--tools-dir`, `--input`, `--session`, `-i`, `--plugin`, `--protocol`, `--safe` |
| `bundle <flow>` | Pack a flow and everything it runs with into one shareable `.heddle` archive |
| `validate <spec>` | Parse and check a flow — or a `.heddle` bundle — before running it |
| `init <name>` | Scaffold a project |
| `sessions` | Inspect kept conversations: `ls`, `show <id>`, `rm <id>` |

`heddle --help` lists every flag. Four worth knowing about:

- **`--safe`** runs each tool inside an OS sandbox — bubblewrap on Linux,
  Seatbelt on macOS. Without it, a tool is a subprocess with your whole
  environment, API keys included.
- **`--session [id]`** keeps the run in a conversation on disk, under
  `~/.heddle/sessions/`, and gives the agent the turns before it. Each
  invocation is one turn; `heddle sessions` lists and prints them.
- **`-i, --interactive`** opens a terminal chat UI over the flow. On its own the
  conversation lasts as long as the terminal does; add `--session` to keep it.
- **`--plugin <module>`** loads custom component types: transforms, nodes,
  providers, encoders and middleware. Plugins are named on the command line and
  never inside a flow, so sharing a spec cannot cause code to run.

To hand a working agent to someone as one file:

```bash
heddle bundle flow.json --tools-dir tools -o agent.heddle
heddle run agent.heddle
```

The bundle carries the spec, the tools, any manifest plugins and mounted files —
never credentials, which resolve as `$ENV_VAR` on the machine that runs.

## The rest

Full documentation lives at [heddle.run/docs](https://heddle.run/docs). The
engine is [`@heddle/core`](https://www.npmjs.com/package/@heddle/core), usable
as a library, and [`@heddle/server`](https://www.npmjs.com/package/@heddle/server)
serves the same flows over HTTP with SSE streaming.

Source and issues: [heddle-run/heddle](https://github.com/heddle-run/heddle).
MIT licensed.
