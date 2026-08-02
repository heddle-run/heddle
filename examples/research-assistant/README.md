# research-assistant: the first flow to run

The smallest complete agent flow: `start → researcher → end`. The researcher is
an `AgentNode`: an agent with a system prompt, an OpenAI model, and two tools
it can call in a loop until it has an answer.

| File | What it is |
|------|------------|
| `flow.json` | The flow: three nodes, two control edges, two data edges |
| `tools/web_search.py` | A stub search tool; returns canned results, calls no real API |
| `tools/calculator.sh` | Evaluates an arithmetic expression with Python |

The tools are deliberately trivial. `web_search` fabricates its results, so the
example demonstrates the *mechanics*, meaning how a model asks for a tool, how
the answer comes back and how the result reaches the end node, without needing a
search API key. The only credential it needs is the model's.

## Run it

With the CLI installed (or spell `heddle` as `npx @heddle-run/cli`):

```bash
export OPENAI_API_KEY=sk-...

heddle run examples/research-assistant/flow.json \
  --tools-dir examples/research-assistant/tools \
  --input '{"query": "what is a heddle"}'
```

From a source checkout, build first (`pnpm install && pnpm build`) and use the
built CLI instead:

```bash
node packages/cli/dist/heddle.js run examples/research-assistant/flow.json \
  --tools-dir examples/research-assistant/tools \
  --input '{"query": "what is a heddle"}'
```

## What you will see

Progress goes to stderr, one line per node, plus each tool call the model
makes. The final state is printed to stdout as JSON:

```json
{
  "query": "what is a heddle",
  "result": "A heddle is a component of a loom. ..."
}
```

`result` is the researcher's answer, written there because a data flow edge
carries the agent's `result` output to the end node.

## What to look at in the flow

`flow.json` is a plain [Agent Spec](https://oracle.github.io/agent-spec/)
document, and the shape repeats in every larger example:

- **`$referenced_components`** holds each node's definition once; the `nodes`
  and edge lists point into it by id.
- **The `StartNode`** declares one output, `query`, which is why
  `--input '{"query": ...}'` is the shape the run accepts.
- **`control_flow_connections`** say what runs after what;
  **`data_flow_connections`** say which output lands in which input. The two
  are separate on purpose: `query` flows from start to researcher, `result`
  from researcher to end.
- **The agent's tools** are declared inline as `ServerTool` components: name,
  inputs, outputs. At runtime each is matched by name to an executable in
  `--tools-dir`: `web_search` to `web_search.py`, `calculator` to
  `calculator.sh`. The extension is stripped; the name is the contract.

Each tool is a standalone executable that reads a JSON object on stdin and
writes one to stdout. That is the whole tool protocol, and
`tools/web_search.py` shows it in ten lines.
