import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFlow } from '../run-flow.js';
import { loadFlow } from '../spec/load.js';
import type { Event } from '../runner/events.js';

/**
 * A flow that runs on nothing but the engine: no model, no tools. The switch
 * routes on the input and the outcome hands it back, which is enough to see
 * `runFlow` load, compile, and walk a document end to end.
 */
const PASSTHROUGH = `weave: 1
name: passthrough
inputs:
  input: string
steps:
  - name: route
    switch: '{{inputs.input}}'
    cases: {}
    else: done
outcomes:
  done:
    input: '{{inputs.input}}'
`;

let scratch: string;
let flowPath: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'heddle-run-flow-'));
  flowPath = join(scratch, 'flow.yaml');
  writeFileSync(flowPath, PASSTHROUGH);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('runFlow', () => {
  it('runs a flow from a path', async () => {
    const state = await runFlow({
      flow: flowPath,
      inputs: { input: 'hello world' },
    });

    expect(state.get('input')).toBe('hello world');
    expect(state.get('outcome')).toBe('done');
  });

  it('runs a flow that is already parsed', async () => {
    const parsed = loadFlow(flowPath);

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
      runFlow({ flow: flowPath, inputs: { input: 'x' }, maxIterations: 1 }),
    ).rejects.toThrow(/exceeded max iterations \(1\)/);
  });
});
