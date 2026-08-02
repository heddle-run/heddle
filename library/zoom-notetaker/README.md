# zoom-notetaker

Joins a Zoom meeting from its link, waits out the call, and writes up the notes.

Where [meeting-notes](../meeting-notes/README.md) starts from a transcript you
already have, this one goes and gets it. A [Recall.ai](https://recall.ai)
notetaker bot is dispatched into the call, sits through it like any other
participant, and when the meeting ends the transcript comes back and lands in
the same fixed-heading write-up.

```
start ──> join (ToolNode) ──> capture (ToolNode) ──> route ──┬─> notes (LlmNode) ──> end
                                                             └─> end_failed
```

No agent anywhere before the write-up: joining and waiting have no decisions in
them, so they are plain tool steps, and the only branch is the one that matters
— did a transcript come back or not. When it did not (bad link, bot never
admitted, captions off), the run ends at `end_failed` with an error that says
which step went wrong, instead of a model summarizing a meeting it never heard.

## Before you run it

- A [Recall.ai](https://recall.ai) account and api key, in `RECALL_API_KEY`.
  If your dashboard is not in `us-west-2`, set `RECALL_REGION` to match — the
  key only works against its own region.
- Captions turned on in the Zoom meeting. The bot rides the meeting's own
  caption stream (Recall's `meeting_captions` provider), which costs nothing
  extra but means no captions, no transcript — the run says so rather than
  guessing.
- Someone in the meeting to admit the bot if a waiting room is on, and the
  participants told a notetaker is present. Recording laws are consent laws.

## Run it

```bash
node library/build.mjs zoom-notetaker
heddle run library/dist/zoom-notetaker.heddle \
  --input '{"meeting_url":"https://zoom.us/j/<your-meeting>"}'
```

The run joins, then waits — as long as the meeting does, up to
`max_wait_minutes` (default 180). Start it when the meeting starts and let it
sit. The optional inputs:

```bash
heddle run library/dist/zoom-notetaker.heddle \
  --input '{"meeting_url":"https://zoom.us/j/<your-meeting>","bot_name":"minutes bot","max_wait_minutes":60}'
```

Or straight from source while you are editing it:

```bash
heddle run library/zoom-notetaker/spec.yaml \
  --tools-dir library/zoom-notetaker/tools \
  --input '{"meeting_url":"https://zoom.us/j/<your-meeting>"}'
```

Under `--safe`, forward the key into the sandbox and leave the network open —
these tools are nothing but network:

```bash
heddle run library/dist/zoom-notetaker.heddle --safe \
  --allow-env RECALL_API_KEY --allow-env RECALL_REGION \
  --input '{"meeting_url":"https://zoom.us/j/<your-meeting>"}'
```

## What it writes

Four headings, always in this order, and only what the transcript supports:

- **Summary** — two or three sentences on what the meeting was about and where
  it landed.
- **Decisions** — what was actually settled. Discussed but not settled is an
  open question, not a decision.
- **Action items** — `owner — what — by when`, with `unassigned` and
  `not stated` where the meeting did not say.
- **Open questions** — what was raised and left hanging.

The prompt tells the model the captions are rough — misspelled names, cut
sentences — and that an empty heading is a correct answer. The failure worth
designing against is the same one meeting-notes names: minutes that assign
owners and dates nobody agreed to.

## What it will not do

- Transcribe a meeting with captions off, or one already over. The bot has to
  be in the call while it happens; there is no joining retroactively.
- Hide. The bot is visible in the participant list under `bot_name` — that is
  a feature, not a limitation.
- Speak, or answer questions in the call. It only listens.

Zoom links are what the README promises, but the tools pass the URL through to
Recall.ai unchanged, and Recall also handles Google Meet and Microsoft Teams
links — they work here too.

## Requires

`OPENAI_API_KEY`, `RECALL_API_KEY` (with `RECALL_REGION` when the dashboard is
not `us-west-2`), and `python3` for the two tools. The wait between status
checks is 30 seconds; `RECALL_POLL_SECONDS` changes it.
