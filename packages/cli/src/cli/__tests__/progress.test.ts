/**
 * How a run's progress reaches stderr.
 *
 * What is pinned here is the framing, not the wording: a model's answer arrives
 * in fragments rather than lines, so it shares a line with a `[node]` prefix
 * written once, and everything else has to close that line before writing. The
 * failure this guards is invisible in a passing run — output from an unrelated
 * event landing in the middle of the model's sentence.
 */
import { describe, it, expect } from 'vitest';
import type { Event } from '@heddle/core';
import { createProgressWriter, renderEvent } from '../progress.js';

/** Collects what the writer would put on stderr. */
function record(verbose = false): {
  feed: (...events: Event[]) => void;
  text: () => string;
} {
  let out = '';
  const write = createProgressWriter((text) => {
    out += text;
  });
  return {
    feed: (...events) => events.forEach((e) => write(renderEvent(e, verbose))),
    text: () => out,
  };
}

const delta = (nodeName: string, d: string): Event => ({
  type: 'token_delta',
  nodeName,
  delta: d,
});

describe('a streamed answer', () => {
  it('shares one line, prefixed once', () => {
    const r = record();
    r.feed(delta('assistant', 'A '), delta('assistant', 'heddle '), delta('assistant', 'lifts.'));
    expect(r.text()).toBe('[assistant] A heddle lifts.');
  });

  it('is closed by the node completing, so the next write starts clean', () => {
    const r = record();
    r.feed(delta('assistant', 'half'), { type: 'node_complete', nodeName: 'assistant' });
    expect(r.text()).toBe('[assistant] half\n');
  });

  it('starts a new line when a different node answers', () => {
    const r = record();
    r.feed(delta('first', 'one'), delta('second', 'two'));
    expect(r.text()).toBe('[first] one\n[second] two');
  });
});

describe('everything else', () => {
  it('never lands in the middle of an answer', () => {
    const r = record();
    r.feed(delta('assistant', 'half'), {
      type: 'warning',
      message: 'the stream failed',
    });
    expect(r.text()).toBe('[assistant] half\nWarning: the stream failed\n');
  });

  // The quiet events say nothing, but they still have to end the answer: the
  // run's JSON result goes to stdout right after, and an unterminated stderr
  // line appears to run into it.
  it('ends the answer even when the event itself is silent', () => {
    const r = record();
    r.feed(delta('assistant', 'done'), { type: 'flow_complete' });
    expect(r.text()).toBe('[assistant] done\n');
  });

  it('stays quiet without --verbose', () => {
    const r = record();
    r.feed({ type: 'flow_start' }, { type: 'node_start', nodeName: 'a', nodeType: 'AgentNode' });
    expect(r.text()).toBe('');
  });

  it('reports the lifecycle with --verbose', () => {
    const r = record(true);
    r.feed({ type: 'flow_start' }, { type: 'node_start', nodeName: 'a', nodeType: 'AgentNode' });
    expect(r.text()).toBe('Flow started\n[a] Starting AgentNode\n');
  });
});
