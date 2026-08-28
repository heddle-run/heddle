# oracle-it-assistant: a multi-agent flow, converted

`spec.yaml` began as one of Oracle's own [Agent Spec](https://oracle.github.io/agent-spec/)
examples — their multi-agent IT-support flow — and is carried here converted
to Weave (the original's copyright notice travels in the file's header). It is
the largest spec in this repo: a tool step gathers the user's information, an
orchestrator agent works out what the problem is about, and a `switch` routes
to one of three specialist agents — network, device or account.

That makes it the one to read for the patterns the small examples do not show:

- **A tool step feeding an agent** — `lookup` runs `get_user_information` and
  the orchestrator's prompt reads `{{lookup.user_information}}`.
- **Structured output as routing input** — the orchestrator declares
  `output: { topic, conversation_summary }`, so the runtime holds the model to
  that JSON shape and `{{orchestrator.topic}}` is a real key, not a hope.
- **A branching table** — `switch` on the topic, `cases` for the three
  specialists, `else: done` for `unknown`.
- **Explicit `then`** — each specialist jumps to `done` rather than falling
  through to the next step in the list.

One thing did not survive the conversion, stated in the file's header: the
original looped each specialist back to the orchestrator until the user was
done. Weave v1 rejects backward edges (loops are reserved for a later format
version), so this document is the single-pass core of the same design —
classify once, route once, answer once.

```bash
heddle validate examples/oracle-it-assistant/spec.yaml
```

```
  Parsed flow: oracle-it-assistant
  Graph validation passed
Valid: examples/oracle-it-assistant/spec.yaml
```

From a source checkout, use `node packages/cli/dist/heddle.js validate …`
after `pnpm install && pnpm build`.

Running it still takes two things the spec leaves open: the model `url` is the
placeholder `LLAMA_PLACEHOLDER_LINK`, and the user-information tool has no
executable here. Point the model at a live endpoint and provide
`get_user_information` in a `--tools-dir`, and it runs:

```bash
heddle run examples/oracle-it-assistant/spec.yaml \
  --tools-dir <your-tools> \
  --input '{"username": "jsmith", "problem": "my laptop cannot reach the VPN"}'
```
