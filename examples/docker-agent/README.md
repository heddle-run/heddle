# Docker agent: reading another spec through an input format

This example adds no component to a flow and changes nothing about how one
runs. It changes what heddle can *read*, by supplying an **input format**: the
input mirror of [ag-ui](../ag-ui/README.md)'s encoder. Where an encoder renders
the run's output into another wire format, an input format reads the spec in
from one.

The spec here is a [Docker agent file](https://docs.docker.com/ai/docker-agent/configuration/overview/)
(cagent's YAML configuration), which is not another encoding of Weave but
a different schema with different ideas: named agents, a models table, an
`instruction` instead of a templated prompt. The format's `parse` is a
translator: Docker agent document in, Weave document out — the root agent
becomes Weave's one-step `agent:` sugar. Everything downstream (validation,
compilation, the run) never learns the file was not Weave to begin with.

| File | What it is |
|------|------------|
| `format.mjs` | The plugin: the `docker-agent` format, the translation, and a deliberately small YAML reader so the example stays dependency-free |
| `agent.yaml` | A Docker agent file, exactly as cagent's own tooling would read it |

## Run it

Validation needs no credential, run from the repository root:

```bash
heddle validate examples/docker-agent/agent.yaml \
  --format docker-agent --plugin ./examples/docker-agent/format.mjs
```

```
  Parsed flow: quayside
  Graph validation passed
Valid: examples/docker-agent/agent.yaml
```

Running it is no different from any Weave flow: an OpenAI key, a question
in, an answer out.

```bash
OPENAI_API_KEY=sk-… heddle run examples/docker-agent/agent.yaml \
  --format docker-agent --plugin ./examples/docker-agent/format.mjs \
  --input '{"query": "Can the Meridian unload tomorrow morning?"}'
```

## How the format is selected

Twice in the commands above, once implicitly:

- `--format docker-agent` names it outright. That is needed for `agent.yaml`
  because **`.yaml` belongs to the builtin YAML format and a plugin may not
  claim it**: what a `.yaml` file means must not depend on which plugins are
  loaded.
- The format claims `.cagent` as its own, so a file named that way needs no
  flag at all: `heddle validate agent.cagent --plugin …` resolves by extension.
- Over HTTP it is the request's `"format"` field beside a string `"flow"`;
  `GET /v1/capabilities` lists the names a server accepts.

## What refuses, and why

Translation is honest about its edges. A Docker agent file declaring
`toolsets`, `sub_agents`, `rag` or `mcps` is refused by name:

```
"agents.root" declares "toolsets", which this translator does not carry. …
```

Refused, not dropped: a toolset silently discarded would run a *different
agent* than the file describes, and it would do so without saying so. The same
goes for providers: `openai` maps to heddle's `provider: openai` and `dmr`
(Docker Model Runner) to `provider: openai-compatible` pointed at the local
engine, while a provider heddle has no client for is refused with the list of
what would work.

The refusal messages all point the same direction, and it is the real lesson of
the example: a format is one entry in an ordinary plugin. A fuller integration
would declare, *beside* the format, the tools its toolsets need, a `provider`
for the models heddle cannot reach, and custom component types for delegation:
one plugin, one `--plugin` flag, and the translator stops refusing things
because it can finally carry them.

## The YAML reader

`format.mjs` parses its YAML with a small subset reader written into the
example, because heddle's examples run from a bare checkout with nothing
installed. It is scaffolding, not the point: a real deployment of this format
would import a YAML library and delete that half of the file. `parse` is
yours: whatever turns text into a Weave document is a valid format.
