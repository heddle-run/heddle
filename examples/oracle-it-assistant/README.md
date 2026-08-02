# oracle-it-assistant: a multi-agent flow written somewhere else

`spec.yaml` is one of Oracle's own [Agent Spec](https://oracle.github.io/agent-spec/)
examples, carried here unmodified (it keeps Oracle's copyright header). It is
the largest spec in this repo: an IT-support flow where a `ToolNode` gathers
the user's information, an orchestrator agent works out what the conversation
is about, and a `BranchingNode` routes to one of three specialist agents,
network, device or account, each of which reports back to the orchestrator
until the flow ends.

That makes it the one to read for the patterns the small examples do not show:
multi-agent orchestration, a branching table (`mapping: {account, device,
network}` with a `default` fall-through), cycles back to the orchestrator, and
data flow edges threading a conversation summary between agents.

```bash
heddle validate examples/oracle-it-assistant/spec.yaml
```

```
  Parsed Flow: Oracle IT Assistant Flow
  Graph validation passed
Valid: examples/oracle-it-assistant/spec.yaml
```

From a source checkout, use `node packages/cli/dist/heddle.js validate …`
after `pnpm install && pnpm build`.

Unlike the bare-`Agent` examples ([math-homework-agent](../math-homework-agent),
[rag-agent](../rag-agent)) this one *is* a flow, so `heddle run` accepts its
shape, but running it still takes two things the spec leaves open: the model
`url` is the placeholder `LLAMA_PLACEHOLDER_LINK`, and the user-information
tool has no executable here. Point the config at a live endpoint and provide
the tool in a `--tools-dir`, and it runs.
