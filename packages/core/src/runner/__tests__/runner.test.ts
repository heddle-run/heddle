import { describe, it, expect } from 'vitest';
import { parseFlowObject } from '../../spec/parser.js';
import { compile } from '../../graph/compile.js';
import { Runner } from '../runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../options.js';
import type { Dependencies } from '../../node/types.js';
import type { Event } from '../events.js';

/** A provider that answers with the prompt it was sent, marked. */
const echoProvider = {
  chatCompletion: async (
    _signal: AbortSignal | undefined,
    request: { messages: Array<{ content: string }> },
  ) => ({
    content: `echo: ${request.messages.at(-1)?.content ?? ''}`,
    finish_reason: 'stop',
  }),
};

const deps: Dependencies = { createProvider: () => echoProvider };

const SIMPLE = {
  weave: 1,
  name: 'simple',
  inputs: { input: 'string' },
  steps: [
    {
      name: 'reply',
      llm: {
        model: { provider: 'openai', model: 'gpt-4o' },
        prompt: 'say {{inputs.input}}',
      },
    },
  ],
  outcomes: {
    done: { input: '{{inputs.input}}', text: '{{reply.text}}' },
  },
};

const BRANCHING = {
  weave: 1,
  name: 'branching',
  inputs: { category: 'string' },
  steps: [
    {
      name: 'route',
      switch: '{{inputs.category}}',
      cases: { tech: 'tech_end', science: 'science_end' },
      else: 'default_end',
    },
  ],
  outcomes: {
    tech_end: { topic: 'tech' },
    science_end: { topic: 'science' },
    default_end: { topic: 'other' },
  },
};

describe('Runner', () => {
  it('walks inputs through a step to the outcome payload', async () => {
    const cg = compile(parseFlowObject(SIMPLE), deps);
    const runner = new Runner(cg, { ...DEFAULT_RUNNER_OPTIONS });

    const result = await runner.run(undefined, { input: 'hello world' });

    expect(result.get('input')).toBe('hello world');
    expect(result.get('text')).toBe('echo: say hello world');
    expect(result.get('outcome')).toBe('done');
  });

  it('takes the branch a switch selects, and says so in the result', async () => {
    const cg = compile(parseFlowObject(BRANCHING), {});

    const tests = [
      { input: 'tech', wantEnd: 'tech_end' },
      { input: 'science', wantEnd: 'science_end' },
      { input: 'other', wantEnd: 'default_end' },
    ];

    for (const tt of tests) {
      const events: Event[] = [];
      const runner = new Runner(cg, {
        ...DEFAULT_RUNNER_OPTIONS,
        eventHandler: (e: Event) => events.push(e),
      });

      const result = await runner.run(undefined, { category: tt.input });

      expect(result.get('outcome')).toBe(tt.wantEnd);
      const reached = events
        .filter((e) => e.type === 'node_complete' && e.nodeType === 'outcome')
        .map((e) => e.nodeName);
      expect(reached).toEqual([tt.wantEnd]);
    }
  });

  it('emits events', async () => {
    const cg = compile(parseFlowObject(SIMPLE), deps);

    const events: Event[] = [];
    const opts = { ...DEFAULT_RUNNER_OPTIONS };
    opts.eventHandler = (e: Event) => {
      events.push(e);
    };

    const runner = new Runner(cg, opts);
    await runner.run(undefined, { input: 'test' });

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0].type).toBe('flow_start');
    expect(events[events.length - 1].type).toBe('flow_complete');
  });
});
