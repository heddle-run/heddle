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
| `run <flow>` | Run a flow. `--tools-dir`, `--input`, `--chat`, `--plugin`, `--protocol`, `--safe` |
| `validate <spec>` | Parse and check a flow before running it |
| `init <name>` | Scaffold a project |

`heddle --help` lists every flag. Three worth knowing about:

- **`--safe`** runs each tool inside an OS sandbox — bubblewrap on Linux,
  Seatbelt on macOS. Without it, a tool is a subprocess with your whole
  environment, API keys included.
- **`--chat`** opens a multi-turn session over the same flow, saved to
  `~/.heddle/conversations/`.
- **`--plugin <module>`** loads custom component types: transforms, nodes,
  providers, encoders and middleware. Plugins are named on the command line and
  never inside a flow, so sharing a spec cannot cause code to run.

## The rest

Full documentation lives at [heddle.run/docs](https://heddle.run/docs). The
engine is [`@heddle/core`](https://www.npmjs.com/package/@heddle/core), usable
as a library, and [`@heddle/server`](https://www.npmjs.com/package/@heddle/server)
serves the same flows over HTTP with SSE streaming.

Source and issues: [heddle-run/heddle](https://github.com/heddle-run/heddle).
MIT licensed.
