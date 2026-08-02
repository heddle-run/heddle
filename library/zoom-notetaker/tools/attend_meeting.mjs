#!/usr/bin/env node
/**
 * Attend a Zoom meeting in a headless browser and bring back the captions.
 *
 * No cloud API and no npm install: this drives a local Chromium over the
 * DevTools protocol using Node's built-in WebSocket (node >= 22), joins the
 * meeting through Zoom's web client (zoom.us/wc/join/...), turns on live
 * captions, and commits caption lines as they stabilize in the DOM. When the
 * meeting ends — or max_wait_minutes runs out — the collected lines come back
 * as the transcript.
 *
 * One tool rather than a join/wait pair because the browser session has to
 * stay alive from the first click to the last caption; two processes cannot
 * share it.
 *
 * Environment:
 *   CHROME_BIN              path to a Chromium/Chrome binary (otherwise
 *                           common names and install paths are searched)
 *   ZOOM_POLL_SECONDS       seconds between caption harvests (default 5)
 *   ZOOM_JOIN_MINUTES       how long to keep trying to get into the meeting,
 *                           waiting room included (default 10)
 *   ZOOM_CAPTION_SELECTORS  comma-separated CSS selectors for caption items,
 *                           when Zoom's markup drifts from the defaults
 *
 * Like every tool in the library: a failure is data, not a crash. The answer
 * always carries outcome, transcript and error, and the flow branches on it.
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
      }, 30000);
    });
    this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    return waiter;
  }
}

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

/**
 * Runs inside the page on every poll: dismiss consent dialogs, get the bot
 * through the join form, switch captions on, and keep committing caption
 * lines as they stabilize. Idempotent — the web client navigates between the
 * preview and the meeting, and each new document just gets set up again.
 */
function pageStep(botName, pull) {
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

    // An empty caption container is present before captions are on, so "is
    // any text flowing" is the test — and only ever click the *show* wording:
    // once captions are on the same control reads "Hide Captions", and a
    // broad match would toggle them back off.
    const cap0 = window.__heddleCap;
    const flowing = cap0.committed.length > 0 || cap0.current.size > 0;
    if (!flowing) {
      const captionButton = document.querySelector(
        'button[aria-label*="show captions" i], button[aria-label*="turn on captions" i], ' +
        'button[aria-label*="enable captions" i], button[aria-label*="live transcript" i]');
      if (captionButton) captionButton.click();
      else clickByText(/^(show captions|turn on captions)$/i);
    }

    const bodyText = (document.body && document.body.innerText) || '';
    window.__heddleCap.grab();
    const total = window.__heddleCap.committed.length;
    const from = ${pull} <= total ? ${pull} : 0;
    return JSON.stringify({
      total,
      lines: window.__heddleCap.committed.slice(from),
      ended: ${ENDED.toString()}.test(bodyText),
      refused: ${REFUSED.toString()}.test(bodyText),
      waiting: /host will let you in|waiting room/i.test(bodyText),
    });
  })()`;
}

async function attend(args) {
  const meetingUrl = String(args.meeting_url || '').trim();
  const botName = String(args.bot_name || '').trim() || 'heddle notetaker';
  const maxWaitMinutes = Number(args.max_wait_minutes) > 0 ? Number(args.max_wait_minutes) : 180;
  const joinMinutes = Number(process.env.ZOOM_JOIN_MINUTES) > 0 ? Number(process.env.ZOOM_JOIN_MINUTES) : 10;
  const pollSeconds = Number(process.env.ZOOM_POLL_SECONDS) > 0 ? Number(process.env.ZOOM_POLL_SECONDS) : 5;

  if (!meetingUrl) return { outcome: 'failed', error: 'no meeting_url was given' };
  const url = webClientUrl(meetingUrl);
  if (!url) return { outcome: 'failed', error: `meeting_url does not look like a link: ${meetingUrl}` };

  const chrome = findChrome();
  if (!chrome) {
    return {
      outcome: 'failed',
      error: 'no Chromium or Chrome binary found — install one, or point CHROME_BIN at it',
    };
  }

  const profileDir = mkdtempSync(join(tmpdir(), 'heddle-zoom-'));
  const { child, wsUrl } = launchChrome(chrome, profileDir);
  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  try {
    const cdp = await Cdp.connect(await wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true },
        sessionId,
      );
      if (exceptionDetails) throw new Error(exceptionDetails.text || 'page script failed');
      return result.value;
    };

    await cdp.send('Page.navigate', { url }, sessionId);

    const lines = [];
    const joinDeadline = Date.now() + joinMinutes * 60_000;
    const deadline = Date.now() + maxWaitMinutes * 60_000;
    let admitted = false;

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));

      let step;
      try {
        step = JSON.parse(await evaluate(pageStep(botName, lines.length)));
      } catch {
        // Mid-navigation the context vanishes for a beat; the next poll
        // lands in the new document.
        continue;
      }

      if (step.total < lines.length) lines.length = 0;
      lines.push(...step.lines);
      if (lines.length > 0) admitted = true;

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
      if (Date.now() > deadline) {
        if (lines.length > 0) break; // leave with what we heard
        return {
          outcome: 'failed',
          error: `the meeting was still running after ${maxWaitMinutes} minutes with ` +
            'nothing captured — raise max_wait_minutes if it was expected to run longer',
        };
      }
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
