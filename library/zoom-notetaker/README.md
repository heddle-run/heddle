# zoom-notetaker

Joins a Zoom meeting in a headless browser, records it, and writes up the
notes. No meeting-bot service in the loop — the browser, the recording and
the write-up all run from your machine.

Where [meeting-notes](../meeting-notes/README.md) starts from a transcript you
already have, this one goes and gets it: one tool drives a local headless
Chromium into the call through Zoom's web client (`zoom.us/wc/join/…`),
records the meeting's audio in the page, and transcribes it with whisper.cpp
on your machine — the audio never leaves it. whisper is a prerequisite the
CLI checks before the run and offers to install when missing; env vars swap
in another transcriber entirely. When the meeting ends, what it heard lands
in the same fixed-heading write-up.

```
start ──> attend (ToolNode) ──> route ──┬─> notes (LlmNode) ──> end
                                        └─> end_failed
```

One tool rather than a join/record/transcribe pipeline because the browser
session has to stay alive from the first click to the last word. It has no
decisions in it, so it is a plain tool step, not an agent, and the flow's
only branch is the one that matters — did a transcript come back or not.
When it did not (no browser installed, join refused, nothing made a sound,
the transcriber failed), the run ends at `end_failed` with an error that says
which step went wrong, instead of a model summarizing a meeting it never
heard.

The tool is dependency-free on purpose: no puppeteer, no npm install. It
speaks the DevTools protocol over Node's built-in WebSocket (node ≥ 22) to
any Chromium or Chrome already on the machine, and taps the call's audio —
WebRTC tracks, media elements, WebAudio graphs — into one recorder, drained
in standalone webm segments so a three-hour meeting never becomes one giant
file.

## Choosing the transcriber

Local whisper.cpp is the default; everything else is env vars, and the spec
never changes.

| Variable | Default | What it does |
|---|---|---|
| `ZOOM_TRANSCRIBER` | `stt` | `stt` records audio and runs a model; `captions` reads Zoom's live captions instead |
| `WHISPER_MODEL` | `~/.heddle/models/ggml-base.en.bin` | the ggml model the default local transcriber runs |
| `WHISPER_VAD_MODEL` | `~/.heddle/models/ggml-silero-v5.1.2.bin` | Silero voice-activity model, used when present |
| `STT_URL` | — | an OpenAI-compatible `/audio/transcriptions` endpoint, which replaces the local whisper |
| `STT_MODEL` | `whisper-1` | the model name sent to that endpoint |
| `STT_API_KEY` | `$OPENAI_API_KEY` | bearer token for the endpoint |
| `STT_LANGUAGE` | — | optional language hint, e.g. `en` |
| `STT_COMMAND` | — | a local command that replaces both of the above; it runs under `/bin/sh`, `{audio}` becomes a webm path, stdout is the transcript |
| `STT_CHUNK_MINUTES` | `10` | minutes of audio per transcribed segment |

Three configurations worth naming:

```bash
# Default: whisper.cpp on this machine. Audio never leaves it. The notes
# still go to the model the spec names, on OPENAI_API_KEY.
heddle run library/dist/zoom-notetaker.heddle --input '{"meeting_url":"…"}'

# The OpenAI transcription API instead — audio goes to the cloud, nothing
# local to install beyond the browser.
STT_URL=https://api.openai.com/v1/audio/transcriptions \
  heddle run library/dist/zoom-notetaker.heddle --input '{"meeting_url":"…"}'

# A local OpenAI-compatible server (faster-whisper-server, speaches, …).
STT_URL=http://127.0.0.1:8000/v1/audio/transcriptions STT_MODEL=Systran/faster-whisper-small \
  heddle run library/dist/zoom-notetaker.heddle --input '{"meeting_url":"…"}'
```

`ZOOM_TRANSCRIBER=captions` needs none of the above: it harvests the caption
text Zoom already renders. The trade is that captions must be available in
the meeting (a host setting), and caption quality is Zoom's, not yours.

### What the built-in whisper mode does for you

The short command line you would expect to write —
`whisper-cli -m model.bin -nt -f {audio}` — is wrong in three ways, and none
of them announce themselves. The built-in mode exists so nobody has to
rediscover them:

- **whisper cannot read the audio.** Segments arrive as webm/opus; whisper.cpp
  reads wav, flac, mp3 and ogg. It also exits `0` on a file it could not
  decode, so nothing raises: the segment comes back empty and that stretch of
  the meeting is simply missing from the notes. The tool converts every
  segment to 16 kHz mono WAV with `ffmpeg` first — which is why ffmpeg is on
  the requirements list.
- **`-nt` drops speech.** `--no-timestamps` reads like an output-formatting
  flag. In whisper.cpp 1.9.1 it changes the decode: whole clauses go missing,
  deterministically and without a warning. Reproduced on `base.en`,
  `medium.en` and `large-v3-turbo` against the same WAV, where the `-nt` run
  lost the half of a sentence carrying a deadline that the plain run heard.
  The tool lets whisper print the timestamps and strips them itself.
- **Silence comes back as speech.** Handed a segment nobody spoke in, whisper
  answers `You` or `Thank you.` A meeting is mostly silence from any one
  microphone, so those pile up in the text the notes get written from.
  `--suppress-nst` does not fix it; voice activity detection does — the tool
  passes `--vad` whenever the VAD model file exists.

If you want a different model, point `WHISPER_MODEL` at any ggml file. If you
want a different pipeline entirely, `STT_COMMAND` still takes a command of
your own: a path in, the transcript on stdout, and a non-zero exit if it
could not do the job — with all three traps above yours to dodge again.

## Before you run it

- **node ≥ 22** and a **Chromium or Chrome**. Common names and install paths
  are searched; `CHROME_BIN=/path/to/chrome` pins one.
- **whisper.cpp, ffmpeg and the models** for the default transcriber — or an
  `STT_*` opt-out, or captions mode and a host with captions allowed.
- **"Join from browser" allowed** for the meeting (a Zoom host setting), and
  someone in the call to admit the bot if a waiting room is on.
- **Consent.** The bot is visible in the participant list under `bot_name` —
  that is a feature — and in stt mode it records the call. Tell people, and
  know your jurisdiction: recording laws are consent laws.

Everything but the Zoom settings and the consent is declared in
`bundle.json`, so the bundle checks itself rather than failing at whichever
gap you hit first:

```bash
heddle doctor library/dist/zoom-notetaker.heddle
```

It lists everything missing at once, installs nothing, and exits non-zero if
anything is — worth running before the meeting rather than during it. `heddle
run` makes the same check before it opens a browser, and on a terminal it
goes one further: for whisper-cli, ffmpeg and the two model files it knows
the fix — `brew install`, a Hugging Face download into `~/.heddle/models` —
shows the exact commands, and runs them if you answer `y`. Note that the
whisper prerequisites are checked even when an `STT_*` variable opts out of
using them: the requirements list describes the bundle's default, and an
env-var decision is not something a static declaration can read. `heddle run
--no-preflight` skips the check when that bothers you.

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

The remaining knobs: `ZOOM_JOIN_MINUTES` (default 10) is how long to keep
trying to get in — waiting-room time included — and `ZOOM_POLL_SECONDS`
(default 5) is how often the page is checked.

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

The prompt tells the model machine transcription is rough — misspelled
names, unlabeled speakers, cut and repeated sentences — and that an empty
heading is a correct answer. The failure worth designing against is the same
one meeting-notes names: minutes that assign owners and dates nobody agreed
to.

## The honest caveat

This rides Zoom's web client, which Zoom redesigns on its own schedule. The
join sequence uses several selector spellings rather than one brittle class
name, but markup drift is the way this entry will eventually break. The
audio taps are less exposed — WebRTC tracks are how remote voices arrive,
whatever the UI looks like — and in captions mode,
`ZOOM_CAPTION_SELECTORS` (a comma-separated CSS selector list) repairs a
drifted caption harvest with no code edit.

## What it will not do

- Join a meeting already over. The bot has to be in the call while it
  happens; there is no joining retroactively.
- Hide. The bot is in the participant list under `bot_name`.
- Speak, or answer questions in the call. It only listens.
- Label speakers in stt mode. Plain transcription hears one mixed audio
  stream; captions mode gets Zoom's speaker labels, at the cost of caption
  quality and the host's caption setting.

## Requires

`whisper-cli`, `ffmpeg` and the two model files under `~/.heddle/models` for
the default local transcription (`heddle run` offers to install all four),
`OPENAI_API_KEY` for the notes, `node` (≥ 22, for the built-in WebSocket the
DevTools connection rides), and a Chromium or Chrome for the tool to drive.
By default no audio leaves the machine; only the transcript goes to the
notes model.
