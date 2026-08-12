# rag-agent: retrieval is just a tool

`spec.yaml` began as one of Oracle's own [Agent Spec](https://oracle.github.io/agent-spec/)
examples and is carried here converted to Weave (the original's copyright
notice travels in the file's header). It is an expert assistant whose domain
arrives as an input (`{{inputs.domain_of_expertise}}` in the prompt), holding
one `rag_tool` that takes a query and returns an array of retrieved passages.

The shape worth reading is the retrieval tool: retrieval is just a tool whose
output is an array of strings, not a special component type.

```bash
heddle validate examples/rag-agent/spec.yaml
```

```
  Parsed flow: adaptive-expert-agent
  Graph validation passed
Valid: examples/rag-agent/spec.yaml
```

From a source checkout, use `node packages/cli/dist/heddle.js validate …`
after `pnpm install && pnpm build`.

Running it still takes two things the document leaves open: the model `url` is
a placeholder, and there is no `rag_tool` executable here. Point `url` at a
live endpoint and write a `rag_tool` that reads `{"query": ...}` on stdin and
writes `{"results": [...]}` on stdout, backed by whatever index you have:

```bash
heddle run examples/rag-agent/spec.yaml \
  --tools-dir <your-tools> \
  --input '{"domain_of_expertise": "loom mechanics", "request": "how does a heddle lift threads?"}'
```
