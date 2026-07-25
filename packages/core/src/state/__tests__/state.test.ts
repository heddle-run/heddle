import { describe, it, expect } from 'vitest';
import { State } from '../state.js';

describe('State', () => {
  it('creates from data', () => {
    const s = new State({ key: 'value' });
    expect(s.get('key')).toBe('value');
  });

  it('creates empty from null', () => {
    const s = new State(null);
    expect(s.keys().length).toBe(0);
  });

  it('creates empty from undefined', () => {
    const s = new State();
    expect(s.keys().length).toBe(0);
  });

  it('set returns new state without modifying original', () => {
    const s = new State();
    const s2 = s.set('foo', 'bar');

    expect(s.has('foo')).toBe(false);
    expect(s2.get('foo')).toBe('bar');
  });

  it('merge combines states with override', () => {
    const s1 = new State({ a: '1', b: '2' });
    const s2 = new State({ b: 'overridden', c: '3' });

    const merged = s1.merge(s2);

    const tests: Record<string, string> = {
      a: '1',
      b: 'overridden',
      c: '3',
    };

    for (const [k, expected] of Object.entries(tests)) {
      expect(merged.getString(k)).toBe(expected);
    }
  });

  it('clone does not modify original', () => {
    const s = new State({ x: 'y' });
    let c = s.clone();
    c = c.set('x', 'modified');

    expect(s.getString('x')).toBe('y');
  });

  it('JSON round-trip', () => {
    const s = new State({ name: 'test', count: 42 });
    const json = JSON.stringify(s);
    const parsed = JSON.parse(json);

    const s2 = new State(parsed);
    expect(s2.getString('name')).toBe('test');
  });

  it('getString returns string values', () => {
    const s = new State({ str: 'hello', num: 42 });

    expect(s.getString('str')).toBe('hello');
    expect(s.getString('num')).toBeUndefined();
    expect(s.getString('missing')).toBeUndefined();
  });
});
