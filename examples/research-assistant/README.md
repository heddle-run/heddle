# research-assistant: the first flow to run

The smallest complete agent flow: one `agent` step. The researcher is an agent
with a system prompt, an OpenAI model, and two tools it can call in a loop
until it has an answer.

| File | What it is |
|------|------------|
| `flow.json` | The flow: one input, two tool declarations, one agent step |
| `tools/web_search.py` | A stub search tool; returns canned results, calls no real API |
| `tools/calculator.sh` | Evaluates an arithmetic expression with Python |

The tools are deliberately trivial. `web_search` fabricates its results, so the
example demonstrates the *mechanics*, meaning how a model asks for a tool, how
the answer comes back and how the result reaches the run's output, without
needing a search API key. The only credential it needs is the model's.

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

Progress goes to stderr, one line per step, plus each tool call the model
makes. The run's result is printed to stdout as JSON:

```json
{
  "query": "what is a heddle",
  "result": "A heddle is a component of a loom. ...",
  "outcome": "done"
}
```

`result` is the researcher's answer. The document declares no `outcomes`, so
the run ends at the implicit outcome `done`, which echoes what the flow
accumulated — the input and the agent's answer.

## What to look at in the flow

`flow.json` is a plain [Weave](https://heddle.run/docs) document, and the
shape repeats in every larger example:

- **`inputs`** declares one field, `query`, which is why
  `--input '{"query": ...}'` is the shape the run accepts.
- **`{{inputs.query}}`** in the prompt is the data flow. A template reference
  is the whole wiring: the step receives exactly the values its templates
  name, and an unresolvable reference is a load-time error, not a silent hole.
- **`steps`** is an ordered list; control flow falls through in list order,
  and a one-step flow ends at `done` when the step finishes.
- **The agent's tools** are names into the document's `tools` map: name,
  inputs, outputs. At runtime each is matched by name to an executable in
  `--tools-dir`: `web_search` to `web_search.py`, `calculator` to
  `calculator.sh`. The extension is stripped; the name is the contract.

Each tool is a standalone executable that reads a JSON object on stdin and
writes one to stdout. That is the whole tool protocol, and
`tools/web_search.py` shows it in ten lines.
