# zoom-notetaker

Joins a Zoom meeting in a headless browser, waits out the call, and writes up
the notes. No meeting-bot service, no cloud API — the only network calls are
to Zoom itself and to the model.

Where [meeting-notes](../meeting-notes/README.md) starts from a transcript you
already have, this one goes and gets it: one tool drives a local headless
Chromium into the call through Zoom's web client (`zoom.us/wc/join/…`), turns
on live captions, and commits caption lines as they stabilize in the DOM.
When the meeting ends, what it heard lands in the same fixed-heading write-up.

```
start ──> attend (ToolNode) ──> route ──┬─> notes (LlmNode) ──> end
                                        └─> end_failed
```

One tool rather than a join/wait pair because the browser session has to stay
alive from the first click to the last caption. It has no decisions in it, so
it is a plain tool step, not an agent, and the flow's only branch is the one
that matters — did a transcript come back or not. When it did not (no browser
installed, join refused, captions off), the run ends at `end_failed` with an
error that says which step went wrong, instead of a model summarizing a
meeting it never heard.

The tool is dependency-free on purpose: no puppeteer, no npm install. It
speaks the DevTools protocol over Node's built-in WebSocket (node ≥ 22) to
any Chromium or Chrome already on the machine.

## Before you run it

- **node ≥ 22** and a **Chromium or Chrome**. Common names and install paths
  are searched; `CHROME_BIN=/path/to/chrome` pins one.
- **Captions available in the meeting.** The transcript is the caption
  stream, so the host's settings must allow captions. No captions, no
  transcript — the run says so rather than guessing.
- **"Join from browser" allowed** for the meeting (a Zoom host setting), and
  someone in the call to admit the bot if a waiting room is on.
- **Consent.** The bot is visible in the participant list under `bot_name` —
  that is a feature — but tell people a notetaker is present. Recording laws
  are consent laws.

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

The knobs, all environment variables: `CHROME_BIN` picks the browser,
`ZOOM_JOIN_MINUTES` (default 10) is how long to keep trying to get in —
waiting-room time included — and `ZOOM_POLL_SECONDS` (default 5) is how often
captions are harvested.

A browser is a poor fit for the `--safe` tool sandbox — Chromium wants half
the filesystem and its own process tree. Run this entry unsandboxed and read
the one tool it ships instead; it is a single file with no dependencies.

## What it writes

Four headings, always in this order, and only what the transcript supports:

- **Summary** — two or three sentences on what the meeting was about and
  where it landed.
- **Decisions** — what was actually settled. Discussed but not settled is an
  open question, not a decision.
- **Action items** — `owner — what — by when`, with `unassigned` and
  `not stated` where the meeting did not say.
- **Open questions** — what was raised and left hanging.

The prompt tells the model the captions are rough — misspelled names, cut and
repeated sentences — and that an empty heading is a correct answer. The
failure worth designing against is the same one meeting-notes names: minutes
that assign owners and dates nobody agreed to.

## The honest caveat

This rides Zoom's web client, which Zoom redesigns on its own schedule. The
join sequence and the caption harvest use several selector spellings and a
text-growth heuristic rather than one brittle class name, but markup drift is
the way this entry will eventually break. When captions were on and the run
still says none were captured, set `ZOOM_CAPTION_SELECTORS` to a
comma-separated list of CSS selectors matching the caption items — that is
the whole repair, no code edit needed.

## What it will not do

- Transcribe a meeting with captions off, or one already over. The bot has
  to be in the call while it happens; there is no joining retroactively.
- Hide. The bot is in the participant list under `bot_name`.
- Speak, or answer questions in the call. It only listens.
- Record audio or video. It reads the caption text Zoom already renders,
  which is also why it needs no microphone, no ASR model and no upload.

## Requires

`OPENAI_API_KEY` for the notes, `node` (≥ 22, for the built-in WebSocket the
DevTools connection rides), and a Chromium or Chrome for the tool to drive.
