import { describe, it, expect } from 'vitest';
import { State } from '../state.js';

describe('State', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('constructs empty from %s', (_label, data) => {
    expect(new State(data as never).keys()).toEqual([]);
  });

  it('set, merge and clone leave the original untouched', () => {
    const original = new State({ a: '1', b: '2' });

    const set = original.set('c', '3');
    expect(set.get('c')).toBe('3');
    expect(original.has('c')).toBe(false);

    const merged = original.merge(new State({ b: 'overridden', c: '3' }));
    expect(merged.getString('a')).toBe('1');
    expect(merged.getString('b')).toBe('overridden');
    expect(merged.getString('c')).toBe('3');
    expect(original.getString('b')).toBe('2');

    const cloned = original.clone().set('a', 'modified');
    expect(cloned.getString('a')).toBe('modified');
    expect(original.getString('a')).toBe('1');
  });

  it('getString narrows to strings and answers undefined otherwise', () => {
    const s = new State({ str: 'hello', num: 42 });

    expect(s.getString('str')).toBe('hello');
    expect(s.getString('num')).toBeUndefined();
    expect(s.getString('missing')).toBeUndefined();
    expect(s.get('num')).toBe(42);
  });
});
