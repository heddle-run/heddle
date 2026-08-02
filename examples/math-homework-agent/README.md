# math-homework-agent: a spec written somewhere else

`spec.yaml` is one of Oracle's own [Agent Spec](https://oracle.github.io/agent-spec/)
examples, carried here unmodified (it keeps Oracle's copyright header). It is a
bare `Agent`: a system prompt for a math homework assistant, a vLLM-served
Llama model, and one `multiplication_tool`, with no flow around it.

Its job in this repo is to show portability: a document authored against a
different runtime, parsed and checked by heddle as-is.

```bash
heddle validate examples/math-homework-agent/spec.yaml
```

```
  Parsed Agent: Math homework assistant
Valid: examples/math-homework-agent/spec.yaml
```

From a source checkout, use `node packages/cli/dist/heddle.js validate …`
after `pnpm install && pnpm build`.

It is not runnable as it stands, for two honest reasons: `heddle run` executes
flows, and a bare `Agent` is refused with `expected componentType 'Flow'`; and
the spec's `url` is the placeholder `LLAMA_PUBLIC_ENDPOINT`, not a real
endpoint. To run it, wrap the agent in a flow, an `AgentNode` between a
`StartNode` and an `EndNode`, as [research-assistant](../research-assistant)
does. Point `url` at a live server, and provide a `multiplication_tool`
executable in a `--tools-dir`.
