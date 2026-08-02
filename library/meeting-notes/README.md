# meeting-notes

Turns a raw transcript into decisions, action items and open questions.

One `LlmNode` and nothing else: no tools, no mounts, no files to point it at.
It is the shortest path from an installed heddle to a run that did something
useful, and the flow is small enough to read in one screen — which makes it the
one to copy when you want a prompt of your own on the same rails.

```
start ──> notes (LlmNode) ──> end
```

## Run it

```bash
node library/build.mjs meeting-notes
heddle run library/dist/meeting-notes.heddle
```

The bundle carries a sample transcript, so that runs with no flags. Yours:

```bash
heddle run library/dist/meeting-notes.heddle \
  --input "{\"transcript\": $(jq -Rs . < standup.txt)}"
```

Or straight from source while you are editing the prompt:

```bash
heddle run library/meeting-notes/spec.yaml --input '{"transcript":"..."}'
```

## What it writes

Three headings, always in this order, and only what the transcript supports:

- **Decisions** — what was actually settled. Something discussed but not settled
  is an open question, not a decision.
- **Action items** — `owner — what — by when`, with `unassigned` and
  `not stated` where the meeting did not say.
- **Open questions** — what was raised and left hanging.

An empty heading is a correct answer. The prompt says so explicitly, because the
failure worth designing against here is a model filling in the owner and the
date nobody actually agreed to.

## Making it yours

The whole agent is the `prompt_template` on the `notes` node. Change the
headings, change the format, keep the wiring — a start node with one output, an
`LlmNode` that reads it, an end node that reads what the model wrote.

One thing to know if you rename things: an `LlmNode` writes `generated_text` and
nothing else, whatever its spec declares. The data flow edge is what renames it
to `notes` on the way to the end node. Declaring an output called `summary` does
not create one.

## Requires

`OPENAI_API_KEY`. Nothing else — no tools, so nothing runs on your machine but
heddle itself.
