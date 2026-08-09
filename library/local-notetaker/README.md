# local-notetaker

Records this machine's audio, transcribes it locally, and writes the minutes.
It never joins the meeting, so it does not care which app the meeting is in.

```bash
heddle run library/dist/local-notetaker.heddle --input '{"minutes":60}'
```

Press <kbd>Ctrl</kbd>-<kbd>C</kbd> when the meeting ends. Everything heard up to
that point is transcribed and written up; the `minutes` input is only a ceiling.

No driver to install, no reboot, no Audio MIDI Setup, and nothing to configure.

**macOS only.** Both halves of the recording are platform APIs — Core Audio taps
for the system's output, avfoundation for the microphone. On Linux a PulseAudio
or PipeWire monitor source does the same job; point ffmpeg at one and pipe it
through `STT_COMMAND`.

## Why not a bot

The usual design sends a bot into the call. That route is closing:

- **Zoom** refuses it. The web client answers *"Automated bots aren't allowed to
  join this meeting"*, and Zoom's own docs now say the Meeting SDK "is reserved
  for human use cases and does not support bots or AI notetakers." The sanctioned
  replacement, [RTMS](https://developers.zoom.us/docs/rtms/), needs Developer Pack
  credits — a paid plan, no free tier.
- **Google Meet** flags third-party notetaker bots as a potential risk and
  defaults to denying them entry, so a host has to admit them by hand every time.
  The real-time [Meet Media API](https://developers.google.com/workspace/meet/media-api/guides/overview)
  is developer preview and requires *every participant* to be enrolled in the
  preview programme; the REST transcript API needs Workspace Business Standard or
  higher and does not work on personal accounts.

An audio tap sits below all of that. It is not a bot, it does not authenticate,
and no platform can withdraw it.

## How it hears both halves of a call

macOS does not let an application record system output, only microphone input.
So two sources are recorded and mixed:

| source | carries |
| --- | --- |
| `audiotap` — a Core Audio process tap | the machine's output: everyone else on the call |
| the microphone, via ffmpeg | you |

`audiotap.swift` is built and signed on first run into `~/.heddle/bin/audiotap`.
It creates a [Core Audio process tap](https://developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps)
(macOS 14.2+) and the aggregate device to carry it, in code.

The older way to hear system output is a virtual loopback driver — BlackHole —
plus hand-built Multi-Output and Aggregate devices in Audio MIDI Setup. That
needs an admin password, a reboot, and GUI steps no installer can perform for
you. The tap needs none of it. If you already have such a device the microphone
side will prefer it automatically, but you do not need one.

Building the tap needs `swiftc` (Xcode command line tools). Without it the entry
records the microphone alone and says so — which still captures your end of a
call and everything said in the room.

## Permission, and the one way it goes wrong

A tap needs macOS's audio-recording permission. macOS grants that to **the
application that owns your terminal**, not to the binary — so run it from the
terminal you normally use and accept the prompt on first run.

The failure mode is nasty and worth knowing: **a denied tap records silence
rather than reporting an error.** The IO callback keeps firing at the right rate
with the right frame count, and every sample is zero. Apple's API gives no way
to tell that apart from a quiet room.

In practice this bites when the recorder is launched from inside another
application — an IDE, or an agent running your shell — because the permission is
then attributed to *that* app, which has no audio grant and cannot be prompted
for one. If the transcript comes back empty while the meeting was plainly
audible, this is why. Check with:

```bash
~/.heddle/bin/audiotap > /tmp/tap.raw 2>/tmp/tap.err & sleep 5; kill -INT %1
```

If `/tmp/tap.raw` is all zeros, permission is the reason.

## What it cannot do

It hears **one mixed stream**, so the transcript usually cannot say who spoke.
Speaker labels are what the paid platform APIs sell. It also captures
**everything audible** — a notification, a video, a conversation in the room.

Recording people generally requires telling them, and in some jurisdictions
everyone's consent. That is your call to make, not the tool's.

## Environment

| variable | default | meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | the notes step; transcription is local and needs no key |
| `NO_TAP` | — | `1` skips the system-audio tap, recording the microphone only |
| `NO_MIC` | — | `1` skips the microphone, recording system audio only |
| `AUDIO_DEVICE` | best loopback, else default input | avfoundation device name or index |
| `WHISPER_MODEL` | `~/.heddle/models/ggml-base.en.bin` | the ggml model to run |
| `WHISPER_VAD_MODEL` | `~/.heddle/models/ggml-silero-v5.1.2.bin` | used when present |
| `WHISPER_THREADS` | `6` | decode threads |
| `STT_LANGUAGE` | `en` | spoken language |
| `STT_COMMAND` | — | transcribe with your own command; `{audio}` becomes a WAV path, stdout is the transcript |
| `SEGMENT_SECONDS` | `300` | rolling segment length |

## How it transcribes

Audio is written straight to 16 kHz mono WAV — what whisper wants — in rolling
segments, and each finished segment is transcribed while the recording
continues. On a 60-minute meeting everything but the last segment is already
text by the time you stop it. A crash costs one segment rather than the call.

Recording waits for the tap's first block of audio before starting. That is not
politeness: an aggregate device carrying a tap takes a second or two to spin up
and its callback does not fire until it has — 1.6 s of a 4 s test phrase arrived
when recording started immediately.

Two whisper flags are load-bearing, both learned the hard way:

- **Not `-nt`.** `--no-timestamps` reads like an output-formatting flag, but in
  whisper.cpp 1.9.1 it changes the decode and drops spans of speech. Reproduced
  on `base.en`, `medium.en` and `large-v3-turbo` against the same WAV, where the
  `-nt` run lost a whole clause containing a deadline that the timestamped run
  transcribed fine. So whisper prints timestamps and they come off with a regex.
- **VAD when available.** Without it, a silent stretch hallucinates as `You` or
  `Thank you.` A meeting is mostly silence from any one source, so this matters.
  `--suppress-nst` does not fix it.

Bigger models are a drop-in via `WHISPER_MODEL`. On an M1 Pro, `base.en` runs
around 25× realtime and `large-v3-turbo` around 10× — both far faster than the
meeting, so the ceiling is accuracy rather than speed.
