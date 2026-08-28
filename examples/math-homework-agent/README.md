# math-homework-agent: the one-agent sugar

`spec.yaml` began as one of Oracle's own [Agent Spec](https://oracle.github.io/agent-spec/)
examples — a bare `Agent` with no flow around it — and is carried here
converted to Weave (the original's copyright notice travels in the file's
header). It is the smallest document shape Weave has: `inputs`, a `tools`
declaration, and a top-level `agent:`, which is sugar for a one-step flow
named after the document.

Under the old format a bare `Agent` validated but could not run. Under Weave
the same idea *is* a runnable flow, which is the point of the sugar.

```bash
heddle validate examples/math-homework-agent/spec.yaml
```

```
  Parsed flow: math-homework-agent
  Graph validation passed
Valid: examples/math-homework-agent/spec.yaml
```

From a source checkout, use `node packages/cli/dist/heddle.js validate …`
after `pnpm install && pnpm build`.

Running it still takes two things the document leaves open, on purpose: the
model `url` is the placeholder `LLAMA_PUBLIC_ENDPOINT`, not a real endpoint,
and there is no `multiplication_tool` executable here. Point `url` at a live
vLLM server, provide the tool in a `--tools-dir`, and it runs:

```bash
heddle run examples/math-homework-agent/spec.yaml \
  --tools-dir <your-tools> \
  --input '{"question": "what is 12 times 34?"}'
```
