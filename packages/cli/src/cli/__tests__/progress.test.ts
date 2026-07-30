import { describe, it, expect } from 'vitest';
import type { Event } from '@heddle/core';
import { createProgressWriter, renderEvent } from '../progress.js';

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

describe('what a plugin reports', () => {
  it('prints a log line without --verbose', () => {
    const r = record();
    r.feed({
      type: 'plugin_log',
      nodeName: 'judge',
      nodeType: 'LlmJudge',
      level: 'warn',
      message: 'retrying after a 429',
    });
    expect(r.text()).toBe('[judge] warn: retrying after a 429\n');
  });

  it('holds debug back until --verbose, since it is aimed at the plugin author', () => {
    const quiet = record();
    const loud = record(true);
    const debug: Event = {
      type: 'plugin_log',
      nodeName: 'judge',
      nodeType: 'LlmJudge',
      level: 'debug',
      message: 'cache miss',
    };
    quiet.feed(debug);
    loud.feed(debug);
    expect(quiet.text()).toBe('');
    expect(loud.text()).toBe('[judge] debug: cache miss\n');
  });

  it('closes a streamed answer before writing one', () => {
    const r = record();
    r.feed(delta('assistant', 'half'), {
      type: 'plugin_log',
      nodeName: 'guard',
      nodeType: 'Blocklist',
      level: 'error',
      message: 'blocked',
    });
    expect(r.text()).toBe('[assistant] half\n[guard] error: blocked\n');
  });

  it('prints a namespaced event and its payload with --verbose', () => {
    const r = record(true);
    r.feed({
      type: 'plugin:LlmJudge:progress',
      nodeName: 'judge',
      nodeType: 'LlmJudge',
      data: { done: 3, total: 10 },
    });
    expect(r.text()).toBe('[judge] plugin:LlmJudge:progress {"done":3,"total":10}\n');
  });

  it('prints a namespaced event with no payload at all', () => {
    const r = record(true);
    r.feed({ type: 'plugin:Reverse:started', nodeName: 'reverse', nodeType: 'Reverse' });
    expect(r.text()).toBe('[reverse] plugin:Reverse:started\n');
  });

  it('stays quiet about namespaced events without --verbose', () => {
    const r = record();
    r.feed({
      type: 'plugin:Reverse:row',
      nodeName: 'reverse',
      nodeType: 'Reverse',
      data: { n: 1 },
    });
    expect(r.text()).toBe('');
  });

  it('still closes a streamed answer for the events it says nothing about', () => {
    const r = record();
    r.feed(delta('assistant', 'half'), {
      type: 'plugin:Reverse:row',
      nodeName: 'reverse',
      nodeType: 'Reverse',
    });
    expect(r.text()).toBe('[assistant] half\n');
  });
});
