import { describe, expect, it } from 'vitest';
import { parseFlow, parseFlowObject } from '../parser.js';

const minimal = {
  weave: 1,
  name: 'guarded',
  inputs: { query: 'string' },
  agent: {
    model: { provider: 'openai', model: 'gpt-4o' },
    prompt: 'hi {{inputs.query}}',
  },
};

describe('dangerous keys are refused everywhere in a document', () => {
  it('refuses __proto__ arriving through JSON, where it is an own key', () => {
    // JSON.parse creates "__proto__" as an own property; a literal in test
    // source would instead set the object's prototype and vanish.
    const text = JSON.stringify(minimal).replace(
      '"meta":',
      'never',
    );
    const doc =
      text &&
      `{"weave":1,"name":"guarded","inputs":{"query":"string"},` +
        `"agent":{"model":{"provider":"openai","model":"gpt-4o"},` +
        `"prompt":"hi {{inputs.query}}"},"meta":{"__proto__":{"polluted":true}}}`;

    expect(() => parseFlow(doc)).toThrow(/"__proto__" is not writable/);
  });

  it('refuses constructor as a key inside an opaque config', () => {
    const doc = {
      ...minimal,
      meta: { constructor: 'x' },
    };
    expect(() => parseFlowObject(doc)).toThrow(/"constructor" is not writable/);
  });

  it('refuses prototype nested deep inside arrays', () => {
    const doc = {
      ...minimal,
      meta: { list: [{ prototype: 1 }] },
    };
    expect(() => parseFlowObject(doc)).toThrow(/"prototype" is not writable/);
  });

  it('does not pollute Object.prototype however the parse ends', () => {
    const doc =
      `{"weave":1,"name":"guarded","inputs":{"query":"string"},` +
      `"agent":{"model":{"provider":"openai","model":"gpt-4o"},` +
      `"prompt":"hi {{inputs.query}}"},"meta":{"__proto__":{"polluted":true}}}`;

    expect(() => parseFlow(doc)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('accepts an ordinary document untouched by the guard', () => {
    expect(parseFlowObject(minimal).name).toBe('guarded');
  });
});
