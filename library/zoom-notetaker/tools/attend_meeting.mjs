#!/usr/bin/env node
/**
 * Attend a Zoom meeting in a headless browser and bring back a transcript.
 *
 * No cloud meeting-bot and no npm install: this drives a local Chromium over
 * the DevTools protocol using Node's built-in WebSocket (node >= 22) and
 * joins the meeting through Zoom's web client (zoom.us/wc/join/...).
 *
 * The transcript comes from one of two sources:
 *
 *   stt (default)  The meeting's audio, recorded in the page and run through
 *                  a speech-to-text model you configure with env vars. A
 *                  script injected before Zoom's own code taps remote WebRTC
 *                  audio tracks, media elements and WebAudio graphs into one
 *                  MediaRecorder; the recording is drained in standalone webm
 *                  segments so a long meeting never produces one giant file.
 *   captions       Zoom's own live captions, harvested from the DOM as they
 *                  stabilize. No STT model involved, but the host's settings
 *                  must allow captions.
 *
 * One tool rather than a join/wait pair because the browser session has to
 * stay alive from the first click to the last word; two processes cannot
 * share it.
 *
 * Environment:
 *   ZOOM_TRANSCRIBER        'stt' (default) or 'captions'
 *   STT_URL                 OpenAI-compatible transcription endpoint
 *                           (default https://api.openai.com/v1/audio/transcriptions;
 *                           point it at a local faster-whisper/speaches server
 *                           to keep audio off the cloud)
 *   STT_MODEL               model name sent to that endpoint (default whisper-1)
 *   STT_API_KEY             bearer token for it (default: OPENAI_API_KEY)
 *   STT_LANGUAGE            optional language hint, e.g. 'en'
 *   STT_COMMAND             a local command template that replaces the HTTP
 *                           endpoint entirely. {audio} becomes the path to a
 *                           webm segment; the transcript is whatever the
 *                           command prints. It runs under /bin/sh, so a
 *                           pipeline is allowed — and whisper.cpp needs one:
 *                           convert to 16 kHz mono WAV first (it does not read
 *                           webm), and strip the timestamps with sed instead of
 *                           passing -nt, which in 1.9.1 drops spans of speech
 *                           rather than only the timestamps. The README carries
 *                           the whole line.
 *   STT_CHUNK_MINUTES       minutes of audio per segment (default 10)
 *   CHROME_BIN              path to a Chromium/Chrome binary (otherwise
 *                           common names and install paths are searched)
 *   ZOOM_POLL_SECONDS       seconds between page polls (default 5)
 *   ZOOM_JOIN_MINUTES       how long to keep trying to get into the meeting,
 *                           waiting room included (default 10)
 *   ZOOM_CAPTION_SELECTORS  comma-separated CSS selectors for caption items,
 *                           for when Zoom's markup drifts (captions mode)
 *
 * Like every tool in the library: a failure is data, not a crash. The answer
 * always carries outcome, transcript and error, and the flow branches on it.
 */

import { execFile, spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

const CAPTION_SELECTORS = (process.env.ZOOM_CAPTION_SELECTORS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .concat([
    '[class*="live-transcription"] [class*="item"]',
    '[class*="live-transcription"]',
    '[class*="lt-subtitle"]',
    '[id*="live-transcription"]',
  ]);

const ENDED = /meeting has been ended|this meeting has ended|host has ended (the|this) meeting|you have been removed/i;
const REFUSED = /invalid meeting id|meeting link is not valid|unable to join|incorrect passcode|passcode is wrong|enter the passcode|verify that you are a human|captcha/i;

function answer(outcome, transcript = '', error = '') {
  process.stdout.write(JSON.stringify({ outcome, transcript, error }));
  process.exit(0);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
  });
}

function findChrome() {
  const pinned = (process.env.CHROME_BIN || '').trim();
  if (pinned) return existsSync(pinned) ? pinned : null;
  for (const candidate of CHROME_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      const hit = execSync(`command -v ${candidate}`, { encoding: 'utf8' }).trim();
      if (hit) return hit;
    } catch {
      /* not on PATH — try the next name */
    }
  }
  return null;
}

/** The web-client address for a Zoom link; anything else passes through. */
function webClientUrl(meetingUrl) {
  let url;
  try {
    url = new URL(meetingUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const zoom = /(^|\.)zoom(gov)?\.(us|com)$/i.test(url.hostname);
  const idInPath = url.pathname.match(/\/j\/(\d+)/);
  if (zoom && idInPath) {
    return `${url.origin}/wc/join/${idInPath[1]}${url.search}`;
  }
  return url.href;
}

/* ------------------------------------------------------------------ */
/* Speech-to-text                                                      */

function sttConfig() {
  const command = (process.env.STT_COMMAND || '').trim();
  const apiKey = (process.env.STT_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  return {
    command,
    url: (process.env.STT_URL || 'https://api.openai.com/v1/audio/transcriptions').trim(),
    model: (process.env.STT_MODEL || 'whisper-1').trim(),
    apiKey,
    language: (process.env.STT_LANGUAGE || '').trim(),
    chunkMinutes:
      Number(process.env.STT_CHUNK_MINUTES) > 0 ? Number(process.env.STT_CHUNK_MINUTES) : 10,
  };
}

function transcribeWithCommand(command, audioPath) {
  return new Promise((resolve, reject) => {
    const line = command.replaceAll('{audio}', `'${audioPath.replaceAll("'", "'\\''")}'`);
    execFile('/bin/sh', ['-c', line], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`STT_COMMAND failed: ${(stderr || err.message).slice(0, 400)}`));
      else resolve(stdout.trim());
    });
  });
}

async function transcribeWithApi(stt, audioPath) {
  const form = new FormData();
  form.append('file', new Blob([readFileSync(audioPath)], { type: 'audio/webm' }), 'audio.webm');
  form.append('model', stt.model);
  form.append('response_format', 'json');
  if (stt.language) form.append('language', stt.language);

  const headers = {};
  if (stt.apiKey) headers.Authorization = `Bearer ${stt.apiKey}`;

  const reply = await fetch(stt.url, { method: 'POST', headers, body: form });
  if (!reply.ok) {
    const detail = (await reply.text().catch(() => '')).slice(0, 400);
    throw new Error(`the STT endpoint refused the audio (${reply.status}): ${detail}`);
  }
  const parsed = await reply.json().catch(() => null);
  if (parsed === null || typeof parsed.text !== 'string') {
    throw new Error(`the STT endpoint answered without a "text" field`);
  }
  return parsed.text.trim();
}

async function transcribeSegments(stt, segments) {
  const texts = [];
  for (const segment of segments) {
    const text = stt.command
      ? await transcribeWithCommand(stt.command, segment)
      : await transcribeWithApi(stt, segment);
    if (text) texts.push(text);
  }
  return texts.join('\n');
}

/* ------------------------------------------------------------------ */
/* Chromium                                                            */

function launchChrome(chrome, profileDir) {
  const args = [
    '--headless',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--mute-audio',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
    '--lang=en-US',
    // Zoom serves the web client to browsers, not to things announcing
    // themselves as headless.
    '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  ];
  // Chromium refuses its own sandbox as root, which is what a container
  // usually runs tools as.
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    args.push('--no-sandbox');
  }

  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = new Promise((resolve, reject) => {
    let stderr = '';
    const deadline = setTimeout(
      () => reject(new Error(`the browser printed no DevTools address: ${stderr.slice(-400)}`)),
      20000,
    );
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(deadline);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(deadline);
      reject(new Error(`the browser exited (${code}) before it was ready: ${stderr.slice(-400)}`));
    });
  });
  return { child, wsUrl };
}

/** A minimal DevTools-protocol client over Node's built-in WebSocket. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)));
      ws.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)));
    });
  }

  send(method, params = {}, sessionId = undefined) {
    const id = ++this.seq;
    const waiter = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60000);
    });
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return waiter;
  }
}

/* ------------------------------------------------------------------ */
/* In-page scripts                                                     */

/**
 * Installed before any page script runs (Page.addScriptToEvaluateOnNewDocument),
 * because the taps only catch what is created after them. Remote voices arrive
 * as WebRTC audio tracks; some UIs route them through media elements or a
 * WebAudio graph instead — all three feed one MediaRecorder, and the node side
 * drains it segment by segment, each a standalone webm.
 */
const AUDIO_BOOTSTRAP = `(() => {
  if (window.__heddleAudio) return;
  const audio = window.__heddleAudio = { taps: 0, started: false, parts: [], recorder: null };
  let ctx = null, dest = null;

  const startRecorder = () => {
    audio.parts = [];
    const recorder = new MediaRecorder(dest.stream,
      { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) audio.parts.push(e.data); };
    recorder.start(1000);
    audio.recorder = recorder;
  };

  const master = () => {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      dest = ctx.createMediaStreamDestination();
      startRecorder();
      audio.started = true;
    }
    return { ctx, dest };
  };

  const tapStream = (stream) => {
    try {
      if (!stream || stream.getAudioTracks().length === 0) return;
      const m = master();
      m.ctx.createMediaStreamSource(stream).connect(m.dest);
      audio.taps++;
    } catch (e) { /* a stream that cannot be tapped is not worth dying for */ }
  };

  // Stop the recorder, hand back the finished segment, start the next one.
  audio.rotate = () => new Promise((resolve) => {
    const recorder = audio.recorder;
    if (!recorder || recorder.state !== 'recording') { resolve(''); return; }
    recorder.onstop = () => {
      const blob = new Blob(audio.parts, { type: 'audio/webm' });
      startRecorder();
      const reader = new FileReader();
      reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(blob);
    };
    recorder.stop();
  });

  const NativeRTC = window.RTCPeerConnection;
  if (NativeRTC) {
    const Wrapped = function (...args) {
      const pc = new NativeRTC(...args);
      pc.addEventListener('track', (e) => {
        if (e.track && e.track.kind === 'audio') tapStream(new MediaStream([e.track]));
      });
      return pc;
    };
    Wrapped.prototype = NativeRTC.prototype;
    Object.setPrototypeOf(Wrapped, NativeRTC);
    window.RTCPeerConnection = Wrapped;
  }

  const nativePlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!this.__heddleTapped) {
      this.__heddleTapped = true;
      try { tapStream(this.captureStream()); } catch (e) { /* no captureStream, no tap */ }
    }
    return nativePlay.apply(this, args);
  };

  // Anything a page's own AudioContext plays gets teed into the recorder.
  const nativeConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (target, ...rest) {
    try {
      if (target instanceof AudioDestinationNode && this.context !== ctx) {
        if (!this.context.__heddleTee) {
          this.context.__heddleTee = this.context.createMediaStreamDestination();
          tapStream(this.context.__heddleTee.stream);
        }
        nativeConnect.call(this, this.context.__heddleTee);
      }
    } catch (e) { /* the tee is best-effort; the real connect below is not */ }
    return nativeConnect.apply(this, [target, ...rest]);
  };
})();`;

/**
 * Runs on every poll: dismiss consent dialogs, get the bot through the join
 * form and into computer audio, keep captions on when that mode wants them,
 * and report what the page looks like. Idempotent — the web client navigates
 * between the preview and the meeting, and each new document just gets set
 * up again.
 */
function pageStep(botName, pull, wantCaptions) {
  return `(() => {
    const SELECTORS = ${JSON.stringify(CAPTION_SELECTORS)};
    const clickByText = (pattern) => {
      for (const el of document.querySelectorAll('button, a[role="button"]')) {
        if (pattern.test((el.innerText || '').trim())) { el.click(); return true; }
      }
      return false;
    };

    if (!window.__heddleCap) {
      const cap = { committed: [], last: '', current: new Map() };
      cap.commit = (text) => {
        const line = (text || '').replace(/\\s+/g, ' ').trim();
        if (line && line !== cap.last) { cap.committed.push(line); cap.last = line; }
      };
      // A caption element's text grows as the recognizer refines it. Text
      // that extends what we saw is the same line still forming; text that
      // does not means the old line is finished — commit it. Elements that
      // left the DOM are finished too.
      cap.grab = () => {
        const seen = new Set();
        for (const sel of SELECTORS) {
          for (const el of document.querySelectorAll(sel)) {
            if (seen.has(el)) continue;
            seen.add(el);
            const text = (el.innerText || '').trim();
            if (!text) continue;
            const prev = cap.current.get(el);
            if (prev !== undefined && !text.startsWith(prev)) cap.commit(prev);
            cap.current.set(el, text);
          }
          if (seen.size > 0) break;
        }
        for (const [el, text] of cap.current) {
          if (!el.isConnected) { cap.commit(text); cap.current.delete(el); }
        }
      };
      cap.flush = () => {
        cap.grab();
        for (const [el, text] of cap.current) { cap.commit(text); cap.current.delete(el); }
      };
      window.__heddleCap = cap;
      setInterval(cap.grab, 1000);
    }

    const cookie = document.querySelector('#onetrust-accept-btn-handler');
    if (cookie) cookie.click();
    clickByText(/^(i agree|agree|accept( all)?|got it)$/i);

    const nameInput = document.querySelector('#input-for-name')
      || document.querySelector('input[placeholder*="name" i]');
    if (nameInput && !nameInput.value) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value').set;
      setter.call(nameInput, ${JSON.stringify(botName)});
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (nameInput) clickByText(/^join$/i);

    // Without computer audio the page receives no sound to record.
    clickByText(/^(join audio by computer|join with computer audio|use computer audio)$/i);

    if (${wantCaptions}) {
      // An empty caption container is present before captions are on, so "is
      // any text flowing" is the test — and only ever click the *show*
      // wording: once captions are on the same control reads "Hide
      // Captions", and a broad match would toggle them back off.
      const cap0 = window.__heddleCap;
      const flowing = cap0.committed.length > 0 || cap0.current.size > 0;
      if (!flowing) {
        const captionButton = document.querySelector(
          'button[aria-label*="show captions" i], button[aria-label*="turn on captions" i], ' +
          'button[aria-label*="enable captions" i], button[aria-label*="live transcript" i]');
        if (captionButton) captionButton.click();
        else clickByText(/^(show captions|turn on captions)$/i);
      }
    }

    const bodyText = (document.body && document.body.innerText) || '';
    window.__heddleCap.grab();
    const total = window.__heddleCap.committed.length;
    const from = ${pull} <= total ? ${pull} : 0;
    return JSON.stringify({
      total,
      lines: window.__heddleCap.committed.slice(from),
      audioTaps: window.__heddleAudio ? window.__heddleAudio.taps : 0,
      inMeeting: !!document.querySelector('[aria-label*="leave" i], [class*="footer__leave"]'),
      ended: ${ENDED.toString()}.test(bodyText),
      refused: ${REFUSED.toString()}.test(bodyText),
      waiting: /host will let you in|waiting room/i.test(bodyText),
    });
  })()`;
}

/* ------------------------------------------------------------------ */

async function attend(args) {
  const meetingUrl = String(args.meeting_url || '').trim();
  const botName = String(args.bot_name || '').trim() || 'heddle notetaker';
  const maxWaitMinutes = Number(args.max_wait_minutes) > 0 ? Number(args.max_wait_minutes) : 180;
  const joinMinutes = Number(process.env.ZOOM_JOIN_MINUTES) > 0 ? Number(process.env.ZOOM_JOIN_MINUTES) : 10;
  const pollSeconds = Number(process.env.ZOOM_POLL_SECONDS) > 0 ? Number(process.env.ZOOM_POLL_SECONDS) : 5;
  const mode = (process.env.ZOOM_TRANSCRIBER || 'stt').trim().toLowerCase();
  const stt = sttConfig();

  if (!meetingUrl) return { outcome: 'failed', error: 'no meeting_url was given' };
  if (mode !== 'stt' && mode !== 'captions') {
    return { outcome: 'failed', error: `ZOOM_TRANSCRIBER must be 'stt' or 'captions', not '${mode}'` };
  }
  if (mode === 'stt' && !stt.command && !stt.apiKey && stt.url.includes('api.openai.com')) {
    return {
      outcome: 'failed',
      error: 'stt mode needs a transcriber: set STT_API_KEY (or OPENAI_API_KEY) for the ' +
        'default endpoint, STT_URL for a local server, or STT_COMMAND for a local model. ' +
        'ZOOM_TRANSCRIBER=captions works with none of them',
    };
  }
  const url = webClientUrl(meetingUrl);
  if (!url) return { outcome: 'failed', error: `meeting_url does not look like a link: ${meetingUrl}` };

  const chrome = findChrome();
  if (!chrome) {
    return {
      outcome: 'failed',
      error: 'no Chromium or Chrome binary found — install one, or point CHROME_BIN at it',
    };
  }

  const workDir = mkdtempSync(join(tmpdir(), 'heddle-zoom-'));
  const { child, wsUrl } = launchChrome(chrome, join(workDir, 'profile'));
  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    const cdp = await Cdp.connect(await wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression, awaitPromise = false) => {
      const { result, exceptionDetails } = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise },
        sessionId,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'page script failed');
      return result.value;
    };

    await cdp.send('Page.enable', {}, sessionId);
    if (mode === 'stt') {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_BOOTSTRAP }, sessionId);
    }
    await cdp.send('Page.navigate', { url }, sessionId);

    const lines = [];
    const segments = [];
    const joinDeadline = Date.now() + joinMinutes * 60_000;
    const deadline = Date.now() + maxWaitMinutes * 60_000;
    let admitted = false;
    let lastRotate = Date.now();

    const drainSegment = async () => {
      const base64 = await evaluate('window.__heddleAudio ? window.__heddleAudio.rotate() : ""', true);
      lastRotate = Date.now();
      if (!base64) return;
      const path = join(workDir, `segment-${String(segments.length).padStart(3, '0')}.webm`);
      writeFileSync(path, Buffer.from(base64, 'base64'));
      segments.push(path);
    };

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));

      let step;
      try {
        step = JSON.parse(await evaluate(pageStep(botName, lines.length, mode === 'captions')));
      } catch {
        // Mid-navigation the context vanishes for a beat; the next poll
        // lands in the new document.
        continue;
      }

      if (step.total < lines.length) lines.length = 0;
      lines.push(...step.lines);
      if (step.inMeeting || step.audioTaps > 0 || lines.length > 0) admitted = true;

      if (step.ended) break;
      if (step.refused && !admitted) {
        return {
          outcome: 'failed',
          error: 'Zoom refused the join — check the link (id and passcode), and that ' +
            '"join from browser" is allowed for this meeting',
        };
      }
      if (!admitted && !step.waiting && Date.now() > joinDeadline) {
        return {
          outcome: 'failed',
          error: `not in the meeting after ${joinMinutes} minutes — the bot was never ` +
            'admitted, or the web client page did not open. Raise ZOOM_JOIN_MINUTES ' +
            'if admission was just slow',
        };
      }
      if (mode === 'stt' && admitted && Date.now() - lastRotate > stt.chunkMinutes * 60_000) {
        try { await drainSegment(); } catch { /* the next drain will retry */ }
      }
      if (Date.now() > deadline) {
        if (lines.length > 0 || segments.length > 0 || admitted) break; // leave with what we heard
        return {
          outcome: 'failed',
          error: `the meeting was still running after ${maxWaitMinutes} minutes with ` +
            'nothing captured — raise max_wait_minutes if it was expected to run longer',
        };
      }
    }

    if (mode === 'stt') {
      try { await drainSegment(); } catch { /* the ended page may already be gone */ }
      if (segments.length === 0) {
        return {
          outcome: 'failed',
          error: 'the meeting ended but no audio was recorded — the bot never joined ' +
            'computer audio, or nothing in the call ever produced sound',
        };
      }
      let transcript;
      try {
        transcript = await transcribeSegments(stt, segments);
      } catch (exc) {
        return { outcome: 'failed', error: `speech-to-text failed: ${exc.message}` };
      }
      if (!transcript) {
        return {
          outcome: 'failed',
          error: 'the STT model returned no text for the recorded audio — the meeting ' +
            'may have been silent',
        };
      }
      return { outcome: 'captured', transcript };
    }

    try {
      const flushed = JSON.parse(await evaluate(
        '(() => { window.__heddleCap.flush(); return JSON.stringify(window.__heddleCap.committed); })()',
      ));
      if (flushed.length >= lines.length) {
        lines.length = 0;
        lines.push(...flushed);
      }
    } catch {
      /* the ended page may already be gone; keep what we have */
    }

    const transcript = lines.join('\n');
    if (!transcript) {
      return {
        outcome: 'failed',
        error: 'the meeting ended but no captions were captured — captions must be ' +
          'available in the meeting (host settings) for there to be a transcript. ' +
          'If they were on, Zoom\'s markup may have drifted: set ZOOM_CAPTION_SELECTORS',
      };
    }
    return { outcome: 'captured', transcript };
  } finally {
    cleanup();
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
    const result = await attend(args);
    answer(result.outcome, result.transcript || '', result.error || '');
  } catch (exc) {
    answer('failed', '', `the browser session fell over: ${exc.message}`);
  }
}

main();
