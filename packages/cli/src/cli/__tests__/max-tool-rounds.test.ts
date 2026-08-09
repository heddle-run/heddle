import { describe, expect, it } from 'vitest';
import { DEFAULT_RUNNER_OPTIONS, type RunnerOptions } from '@heddle-run/core';
import { applyMaxToolRounds } from '../run.js';

function opts(): RunnerOptions {
  return { ...DEFAULT_RUNNER_OPTIONS };
}

describe('--max-tool-rounds', () => {
  it('leaves the default when the flag is absent', () => {
    const o = opts();
    applyMaxToolRounds(o, undefined);
    expect(o.maxToolRounds).toBe(DEFAULT_RUNNER_OPTIONS.maxToolRounds);
  });

  it('takes a positive whole number', () => {
    const o = opts();
    applyMaxToolRounds(o, '24');
    expect(o.maxToolRounds).toBe(24);
  });

  it('reads the unlimited words as no ceiling', () => {
    for (const word of ['unlimited', 'none', 'infinite', 'inf', ' UNLIMITED ']) {
      const o = opts();
      applyMaxToolRounds(o, word);
      expect(o.maxToolRounds).toBe(Infinity);
    }
  });

  it('refuses zero, negatives, and nonsense', () => {
    for (const bad of ['0', '-1', '3.5', 'lots']) {
      expect(() => applyMaxToolRounds(opts(), bad)).toThrow(/whole number/);
    }
  });
});
