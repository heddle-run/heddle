import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFlow } from '../../spec/parser.js';
import { compile } from '../../graph/compile.js';
import { Runner } from '../runner.js';
import { DEFAULT_RUNNER_OPTIONS } from '../options.js';
import type { Event } from '../events.js';

const testdataDir = join(import.meta.dirname, '../../../testdata');

describe('Runner', () => {
  it('runs simple flow', async () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);
    const cg = compile(pf, {});

    const opts = { ...DEFAULT_RUNNER_OPTIONS };
    const runner = new Runner(cg, opts);

    const result = await runner.run(undefined, { input: 'hello world' });

    expect(result.get('input')).toBe('hello world');
  });

  it('runs branching flow', async () => {
    const data = readFileSync(
      join(testdataDir, 'branching_flow.json'),
      'utf-8',
    );
    const pf = parseFlow(data);
    const cg = compile(pf, {});

    const tests = [
      { input: 'tech', wantEnd: 'tech_end' },
      { input: 'science', wantEnd: 'science_end' },
      { input: 'other', wantEnd: 'default_end' },
    ];

    for (const tt of tests) {
      const opts = { ...DEFAULT_RUNNER_OPTIONS };
      const runner = new Runner(cg, opts);

      const result = await runner.run(undefined, {
        category: tt.input,
        branching_mapping_key: tt.input,
      });

      expect(result).toBeDefined();
    }
  });

  it('emits events', async () => {
    const data = readFileSync(join(testdataDir, 'simple_flow.json'), 'utf-8');
    const pf = parseFlow(data);
    const cg = compile(pf, {});

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
