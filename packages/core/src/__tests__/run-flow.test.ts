import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFlow } from '../run-flow.js';
import { parseFlow } from '../spec/parser.js';
import type { Event } from '../runner/events.js';

const testdataDir = join(import.meta.dirname, '../../testdata');
const flowPath = join(testdataDir, 'simple_flow.json');

describe('runFlow', () => {
  it('runs a flow from a path', async () => {
    const state = await runFlow({
      flow: flowPath,
      inputs: { input: 'hello world' },
    });

    expect(state.get('input')).toBe('hello world');
  });

  it('runs a flow that is already parsed', async () => {
    const parsed = parseFlow(readFileSync(flowPath, 'utf-8'));

    const state = await runFlow({ flow: parsed, inputs: { input: 'parsed' } });

    expect(state.get('input')).toBe('parsed');
  });

  it('reports the run through onEvent', async () => {
    const events: Event[] = [];

    await runFlow({
      flow: flowPath,
      inputs: { input: 'observed' },
      onEvent: (event) => events.push(event),
    });

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0].type).toBe('flow_start');
    expect(events[events.length - 1].type).toBe('flow_complete');
  });

  it('passes runner options through', async () => {
    await expect(
      runFlow({ flow: flowPath, inputs: {}, maxIterations: 1 }),
    ).rejects.toThrow(/exceeded max iterations \(1\)/);
  });
});
