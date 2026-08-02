# rag-agent: a spec written somewhere else

`spec.yaml` is one of Oracle's own [Agent Spec](https://oracle.github.io/agent-spec/)
examples, carried here unmodified (it keeps Oracle's copyright header). It is a
bare `Agent`: an expert assistant whose domain arrives as an input
(`{{domain_of_expertise}}` in the system prompt), holding one `rag_tool` that
takes a query and returns an array of retrieved passages.

Its job in this repo is to show portability, since it is a document authored
against a different runtime and parsed and checked by heddle as-is, and the shape of a
retrieval tool in a spec: retrieval is just a `ServerTool` whose output is an
array of strings, not a special component type.

```bash
heddle validate examples/rag-agent/spec.yaml
```

```
  Parsed Agent: adaptive_expert_agent
Valid: examples/rag-agent/spec.yaml
```

From a source checkout, use `node packages/cli/dist/heddle.js validate …`
after `pnpm install && pnpm build`.

It is not runnable as it stands: `heddle run` executes flows, and a bare
`Agent` is refused with `expected componentType 'Flow'`; the model `url` is a
placeholder; and there is no `rag_tool` executable here. To run it, wrap the
agent in a flow as [research-assistant](../research-assistant) does, point
`url` at a live endpoint, and write a `rag_tool` that reads
`{"query": ...}` on stdin and writes `{"results": [...]}` on stdout, backed
by whatever index you have.
