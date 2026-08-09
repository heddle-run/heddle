#!/usr/bin/env node
/**
 * record_meeting — tap this machine's audio, transcribe it locally.
 *
 * Reads {"minutes": 60, "device": ""} on stdin and answers
 * {"outcome", "transcript", "error"} on stdout. Nothing else goes to stdout;
 * progress is on stderr, where the person watching a 60-minute recording can
 * see it and the flow will not read it.
 *
 * Why record the machine instead of joining the call: Zoom and Google Meet
 * both block third-party bots now — Zoom refuses the join outright, Meet
 * defaults to denying them entry — and every browser-automation notetaker is
 * on a treadmill against that. A tap below the application layer never asks a
 * platform for permission and never notices which app made the sound.
 *
 * Two sources are mixed, because they carry different halves of a call:
 *
 *   audiotap    the machine's own output — everyone else on the call
 *   microphone  you
 *
 * The tap is a Core Audio process tap (macOS 14.2+), built and signed here
 * from `audiotap.swift`. The older way to hear system output is a virtual
 * loopback driver like BlackHole plus hand-built Multi-Output and Aggregate
 * devices in Audio MIDI Setup — an admin password, a reboot, and GUI steps no
 * installer can perform. The tap needs none of that. It does need macOS's
 * audio-recording permission, which is granted to the app that owns the
 * terminal, so the first run may prompt.
 *
 * Without the tap this still records the microphone alone, which hears your
 * end of a call and everything said in the room.
 *
 * Environment:
 *   AUDIO_DEVICE        avfoundation device name or index (input `device` wins)
 *   NO_TAP=1            skip the system-audio tap, record the microphone only
 *   NO_MIC=1            skip the microphone, record system audio only
 *   WHISPER_MODEL       ggml model      (default ~/.heddle/models/ggml-base.en.bin)
 *   WHISPER_VAD_MODEL   silero VAD      (default ~/.heddle/models/ggml-silero-v5.1.2.bin)
 *   WHISPER_THREADS     default 6
 *   STT_COMMAND         transcribe with your own command instead of whisper-cli;
 *                       {audio} becomes a WAV path, stdout is the transcript
 *   SEGMENT_SECONDS     rolling segment length (default 300)
 */

import { execFile, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HEDDLE_DIR = join(homedir(), '.heddle');
const MODELS_DIR = join(HEDDLE_DIR, 'models');
const BIN_DIR = join(HEDDLE_DIR, 'bin');
const TAP_SOURCE = join(HERE, 'audiotap.swift');
const TAP_BINARY = join(BIN_DIR, 'audiotap');
const WHISPER_MODEL_DEFAULT = join(MODELS_DIR, 'ggml-base.en.bin');
const WHISPER_VAD_DEFAULT = join(MODELS_DIR, 'ggml-silero-v5.1.2.bin');

/** A recorded input we would rather have than the bare microphone. */
const LOOPBACK_HINT = /aggregate|blackhole|loopback|soundflower|multi-output/i;

function answer(outcome, transcript = '', error = '') {
  process.stdout.write(JSON.stringify({ outcome, transcript, error }));
  process.exit(0);
}

function note(line) {
  process.stderr.write(`${line}\n`);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

function run(file, args, failure) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${failure}: ${(stderr || err.message).slice(0, 400)}`));
      else resolve(stdout);
    });
  });
}

function onPath(binary) {
  const dirs = (process.env.PATH || '').split(':').filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, binary)));
}

/* ------------------------------------------------------------------ */
/* The system-audio tap                                                */

const TAP_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>run.heddle.audiotap</string>
  <key>CFBundleName</key><string>heddle audiotap</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>heddle records this meeting's audio so it can transcribe it locally.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>heddle records this meeting's audio so it can transcribe it locally.</string>
</dict>
</plist>
`;

/**
 * Build the tap once, into ~/.heddle/bin, and reuse it after that.
 *
 * The Info.plist is linked into the binary and the result is signed, because
 * macOS shows the audio-recording prompt only to a signed binary carrying a
 * usage description — an unsigned one is never offered the permission and
 * simply receives silence, which is indistinguishable from a quiet room.
 * Ad-hoc signing is enough for a locally built tool.
 *
 * Returns null rather than throwing when it cannot build: no Swift compiler is
 * a reason to record the microphone alone, not a reason to fail the meeting.
 */
async function buildTap() {
  if (!existsSync(TAP_SOURCE)) return null;
  if (
    existsSync(TAP_BINARY) &&
    statSync(TAP_BINARY).mtimeMs >= statSync(TAP_SOURCE).mtimeMs
  ) {
    return TAP_BINARY;
  }
  if (!onPath('swiftc')) {
    note('no swiftc, so no system-audio tap — install Xcode command line tools');
    return null;
  }

  note('building the system-audio tap (first run only)');
  mkdirSync(BIN_DIR, { recursive: true });
  const plist = join(BIN_DIR, 'audiotap.plist');
  writeFileSync(plist, TAP_PLIST);
  try {
    await run('swiftc', [
      '-O', TAP_SOURCE, '-o', TAP_BINARY,
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT',
      '-Xlinker', '__info_plist', '-Xlinker', plist,
    ], 'could not build audiotap');
    await run('codesign', ['-s', '-', '--force', TAP_BINARY], 'could not sign audiotap');
    return TAP_BINARY;
  } catch (exc) {
    note(`${exc.message} — recording the microphone only`);
    return null;
  }
}

/**
 * Start the tap and wait until audio is actually flowing.
 *
 * The wait is not politeness. An aggregate device carrying a tap takes a
 * second or two to spin up and its IO proc does not fire until it has — a
 * measured 1.6 s of a 4 s test phrase arrived when recording started
 * immediately. Holding the recording until the first block means the meeting
 * starts where the user thinks it does.
 */
function startTap(binary) {
  return new Promise((resolve) => {
    const tap = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;

    const give = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === null) tap.kill('SIGINT');
      resolve(value);
    };

    const timer = setTimeout(() => {
      note(`the system-audio tap produced nothing: ${stderr.trim() || 'no output'}`);
      give(null);
    }, 15000);

    tap.stderr.on('data', (chunk) => (stderr += chunk));
    tap.on('error', () => give(null));
    tap.on('exit', () => give(null));

    // The first block is kept, not dropped: it is already meeting audio.
    tap.stdout.once('data', (first) => {
      const match = stderr.match(/FORMAT sampleRate=(\d+) channels=(\d+)/);
      if (!match) return give(null);
      give({
        process: tap,
        first,
        sampleRate: Number(match[1]),
        channels: Number(match[2]),
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* Audio devices                                                       */

/**
 * The avfoundation audio devices, as ffmpeg reports them.
 *
 * ffmpeg prints the list to stderr and then exits non-zero, because listing
 * is not a successful capture. So the failure is the expected path here and
 * only a missing list is an error.
 */
function listDevices() {
  return new Promise((resolve) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
      (_err, _stdout, stderr) => {
        const devices = [];
        let inAudio = false;
        for (const line of (stderr || '').split('\n')) {
          if (/AVFoundation audio devices:/.test(line)) { inAudio = true; continue; }
          if (/AVFoundation video devices:/.test(line)) { inAudio = false; continue; }
          if (!inAudio) continue;
          const match = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
          if (match) devices.push({ index: match[1], name: match[2] });
        }
        resolve(devices);
      },
    );
  });
}

function chooseDevice(devices, asked) {
  if (asked) {
    const match = devices.find(
      (d) => d.index === asked || d.name.toLowerCase() === asked.toLowerCase(),
    );
    if (!match) {
      const known = devices.map((d) => `[${d.index}] ${d.name}`).join(', ') || 'none';
      throw new Error(`no audio device "${asked}". This machine has: ${known}`);
    }
    return match;
  }
  return devices.find((d) => LOOPBACK_HINT.test(d.name)) ?? devices[0];
}

/* ------------------------------------------------------------------ */
/* Transcription                                                       */

function transcribeWithCommand(command, wav) {
  return new Promise((resolve, reject) => {
    const line = command.replaceAll('{audio}', `'${wav.replaceAll("'", "'\\''")}'`);
    execFile('/bin/sh', ['-c', line], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`STT_COMMAND failed: ${(stderr || err.message).slice(0, 400)}`));
      else resolve(stdout.trim());
    });
  });
}

/**
 * One segment through whisper.cpp.
 *
 * Not -nt. In whisper.cpp 1.9.1 --no-timestamps changes the decode itself and
 * drops spans of speech — reproducible on base.en, medium.en and
 * large-v3-turbo, which lose whole clauses the timestamped decode transcribes
 * fine. So whisper prints timestamps and they come off with a regex below.
 * VAD is on when its model is present: without it a silent stretch
 * hallucinates as "You" or "Thank you.", and a meeting has plenty of silence.
 */
async function transcribeWithWhisper(stt, wav) {
  const args = ['-m', stt.model, '-f', wav, '-l', stt.language, '-t', String(stt.threads), '-np'];
  if (existsSync(stt.vad)) args.push('--vad', '-vm', stt.vad);

  const raw = await run('whisper-cli', args, 'whisper-cli failed');
  return raw
    .split('\n')
    .map((line) => line.replace(/^\[[0-9:.]+ --> [0-9:.]+\]\s*/, ''))
    .join(' ')
    // Non-speech annotations, in both the shapes whisper writes them:
    // "[BLANK_AUDIO]" and "(speaks in foreign language)". A near-silent
    // segment produces these instead of nothing, and they read as content to
    // whatever summarises the transcript. Parentheses are safe to drop
    // wholesale because whisper does not put them in ordinary speech.
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function transcribe(stt, wav) {
  return stt.command
    ? transcribeWithCommand(stt.command, wav)
    : transcribeWithWhisper(stt, wav);
}

function sttConfig() {
  return {
    command: (process.env.STT_COMMAND || '').trim(),
    model: (process.env.WHISPER_MODEL || '').trim() || WHISPER_MODEL_DEFAULT,
    vad: (process.env.WHISPER_VAD_MODEL || '').trim() || WHISPER_VAD_DEFAULT,
    threads: Number(process.env.WHISPER_THREADS) > 0 ? Number(process.env.WHISPER_THREADS) : 6,
    language: (process.env.STT_LANGUAGE || 'en').trim(),
  };
}

/** What has to be true before a recording is worth starting. */
function readiness(stt) {
  const missing = [];
  if (!onPath('ffmpeg')) missing.push('ffmpeg is not on PATH (brew install ffmpeg)');
  if (!stt.command) {
    if (!onPath('whisper-cli')) {
      missing.push('whisper-cli is not on PATH (brew install whisper-cpp)');
    }
    if (!existsSync(stt.model)) missing.push(`no whisper model at ${stt.model}`);
  }
  return missing;
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */

/**
 * The ffmpeg invocation for whatever sources exist.
 *
 * Both sources are resampled to 16 kHz mono — what whisper wants — and mixed
 * when there are two, so one transcript covers both halves of the call.
 * `dropout_transition=0` keeps amix from fading a source that goes briefly
 * quiet, which is most of any meeting.
 */
function ffmpegArgs(tap, device, segmentSeconds, dir) {
  const args = ['-hide_banner', '-loglevel', 'error'];

  if (tap) {
    args.push('-f', 'f32le', '-ar', String(tap.sampleRate), '-ac', String(tap.channels), '-i', 'pipe:0');
  }
  if (device) {
    args.push('-f', 'avfoundation', '-i', `:${device.index}`);
  }
  if (tap && device) {
    args.push(
      '-filter_complex',
      '[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[a]',
      '-map', '[a]',
    );
  }

  args.push(
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1',
    join(dir, 'seg-%05d.wav'),
  );
  return args;
}

/** Wait until ffmpeg has actually written audio, not just opened its output. */
async function firstAudio(dir, timeoutMs = 20000) {
  const WAV_HEADER = 44;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const written = readdirSync(dir)
      .filter((f) => f.endsWith('.wav'))
      .some((f) => statSync(join(dir, f)).size > WAV_HEADER);
    if (written) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  note('no audio written yet — recording anyway, but check the input device');
}

async function record(tap, device, seconds, stt, dir) {
  const segmentSeconds = Number(process.env.SEGMENT_SECONDS) > 0
    ? Number(process.env.SEGMENT_SECONDS)
    : 300;

  const ffmpeg = spawn('ffmpeg', ffmpegArgs(tap, device, segmentSeconds, dir), {
    stdio: [tap ? 'pipe' : 'ignore', 'ignore', 'pipe'],
  });

  if (tap) {
    ffmpeg.stdin.on('error', () => {});   // closed when ffmpeg stops; not an error
    ffmpeg.stdin.write(tap.first);
    tap.process.stdout.pipe(ffmpeg.stdin);
  }

  let ffmpegErr = '';
  ffmpeg.stderr.on('data', (chunk) => (ffmpegErr += chunk));

  const texts = new Map();
  let stopping = false;

  // SIGINT is the intended way to end a meeting recording, so it must not kill
  // this process before the last segments are transcribed. The children get
  // the signal, finalize what they are writing, and exit; the transcription
  // that follows runs normally.
  const stop = () => {
    if (stopping) return;
    stopping = true;
    note('stopping — transcribing the last segments');
    if (tap) tap.process.kill('SIGINT');
    ffmpeg.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  // Opening an avfoundation device takes seconds, on top of the tap's own
  // spin-up — measured around seven before the first sample landed. Announcing
  // "recording" before then is a lie the user pays for by losing the opening of
  // the meeting, so wait for bytes on disk and start the clock from there.
  await firstAudio(dir);
  note(`recording — Ctrl-C to stop early, or it ends itself in ${Math.round(seconds / 60)} min`);
  const deadline = setTimeout(stop, seconds * 1000);

  const finished = () =>
    readdirSync(dir).filter((f) => f.endsWith('.wav')).sort().slice(0, -1);

  const sweep = async () => {
    for (const name of finished()) {
      if (texts.has(name)) continue;
      texts.set(name, '');
      try {
        const text = await transcribe(stt, join(dir, name));
        texts.set(name, text);
        if (text) note(`${name}: ${text.slice(0, 70)}${text.length > 70 ? '…' : ''}`);
      } catch (exc) {
        note(`${name} failed to transcribe: ${exc.message}`);
      }
    }
  };

  const exited = new Promise((resolve) => ffmpeg.on('exit', (code) => resolve(code)));
  const ticker = setInterval(() => { void sweep(); }, 15000);

  const code = await exited;
  clearTimeout(deadline);
  clearInterval(ticker);
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (tap) tap.process.kill('SIGINT');

  // ffmpeg exits 255 on SIGINT, which is the normal ending here.
  if (code !== 0 && code !== 255 && !stopping) {
    throw new Error(`ffmpeg stopped (${code}): ${ffmpegErr.slice(-400).trim()}`);
  }

  // Everything now, including the segment that was open when we stopped.
  const all = readdirSync(dir).filter((f) => f.endsWith('.wav')).sort();
  for (const name of all) {
    if (texts.get(name)) continue;
    try {
      texts.set(name, await transcribe(stt, join(dir, name)));
    } catch (exc) {
      note(`${name} failed to transcribe: ${exc.message}`);
    }
  }

  return all.map((name) => texts.get(name) || '').filter(Boolean).join(' ').trim();
}

/* ------------------------------------------------------------------ */

async function capture(args) {
  // Both halves of the recording are macOS-specific — Core Audio taps for the
  // system's output, avfoundation for the microphone — so say so here rather
  // than let ffmpeg fail with "Unknown input format: avfoundation".
  if (process.platform !== 'darwin') {
    return {
      outcome: 'failed',
      error:
        `local-notetaker records through macOS Core Audio and avfoundation, and ` +
        `this is ${process.platform}. On Linux, PulseAudio or PipeWire monitor ` +
        `sources do the same job — point ffmpeg at one and pipe it through ` +
        `STT_COMMAND, or use the meeting-notes entry with a transcript you already have`,
    };
  }

  const minutes = Number(args.minutes) > 0 ? Number(args.minutes) : 60;
  const asked = String(args.device || process.env.AUDIO_DEVICE || '').trim();

  const stt = sttConfig();
  const missing = readiness(stt);
  if (missing.length > 0) {
    return {
      outcome: 'failed',
      error:
        `the local recorder is not ready: ${missing.join('; ')}. ` +
        'Or point STT_COMMAND at your own transcriber',
    };
  }

  // The system-audio tap: everyone else on the call.
  let tap = null;
  if (process.env.NO_TAP !== '1' && process.platform === 'darwin') {
    const binary = await buildTap();
    if (binary) tap = await startTap(binary);
    if (tap) note(`system audio: tapped at ${tap.sampleRate} Hz`);
  }

  // The microphone: you.
  let device = null;
  if (process.env.NO_MIC !== '1') {
    const devices = await listDevices();
    if (devices.length === 0 && !tap) {
      return {
        outcome: 'failed',
        error:
          'no audio input devices and no system-audio tap — macOS may not have ' +
          'granted audio access to the app running this (System Settings > ' +
          'Privacy & Security)',
      };
    }
    if (devices.length > 0) {
      try {
        device = chooseDevice(devices, asked);
        note(`microphone: ${device.name}`);
      } catch (exc) {
        return { outcome: 'failed', error: exc.message };
      }
    }
  }

  if (!tap && !device) {
    return { outcome: 'failed', error: 'nothing to record: no system-audio tap and no microphone' };
  }
  if (!tap) {
    note('no system-audio tap — this hears your end of the call but not the other side');
  }
  note('starting the recorder — wait for "recording" before the meeting starts');

  const dir = mkdtempSync(join(tmpdir(), 'heddle-rec-'));
  try {
    const transcript = await record(tap, device, minutes * 60, stt, dir);
    if (!transcript) {
      return {
        outcome: 'failed',
        error:
          'nothing was transcribed. Either nothing made a sound, or macOS has not ' +
          'granted audio-recording permission to the app running this — a denied ' +
          'tap records silence rather than reporting an error',
      };
    }
    return { outcome: 'captured', transcript };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  let args;
  try {
    args = JSON.parse((await readStdin()) || '{}');
  } catch (exc) {
    answer('failed', '', `could not parse input JSON: ${exc.message}`);
  }

  try {
    const result = await capture(args);
    answer(result.outcome, result.transcript || '', result.error || '');
  } catch (exc) {
    answer('failed', '', `the recorder fell over: ${exc.message}`);
  }
}

main();
