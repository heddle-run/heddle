/**
 * A plugin's report, from the plugin's process to a client's socket.
 *
 * Every piece of this path already has a test and none of them cross the join.
 * `reporting.test.ts` proves plugin -> `PluginHost.serve` -> `pluginReporter` ->
 * `deps.eventHandler`, and stops at a collector array. `sse.test.ts` proves
 * `serializeEvent` + `SseStream.send`, and starts from an `Event` literal
 * somebody typed. What neither touches is `buildDependencies` putting the SSE
 * sink on `deps.eventHandler` in `runs.ts`, which is the only reason a plugin
 * node's event reaches a client at all — drop it and `pluginReporter` calls
 * `handler?.(...)`, every plugin event is silently discarded, and both suites
 * above still pass.
 *
 * The payloads are asserted, not just the frame names. That makes this cover
 * `serializeEvent`'s field list on the same path, so a field dropped there
 * fails here too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

/** start -> the plugin's node -> end. */
const FLOW = {
  component_type: 'Flow',
  name: 'reporting-flow',
  start_node: { $component_ref: 'start' },
  nodes: [
    { $component_ref: 'start' },
    { $component_ref: 'p' },
    { $component_ref: 'end' },
  ],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'start_to_p',
      from_node: { $component_ref: 'start' },
      to_node: { $component_ref: 'p' },
    },
    {
      component_type: 'ControlFlowEdge',
      name: 'p_to_end',
      from_node: { $component_ref: 'p' },
      to_node: { $component_ref: 'end' },
    },
  ],
  $referenced_components: {
    start: {
      component_type: 'StartNode',
      id: 'start',
      name: 'start',
      outputs: [{ title: 'text', type: 'string' }],
    },
    p: {
      component_type: 'ProgressNode',
      id: 'p',
      name: 'p',
      component_plugin_name: 'reporter-plugin',
      component_plugin_version: '1.0.0',
    },
    end: { component_type: 'EndNode', id: 'end', name: 'end' },
  },
};

const PLUGIN = {
  name: 'reporter',
  manifest: {
    name: 'reporter-plugin',
    version: '1.0.0',
    capabilities: ['emitEvent', 'log'],
    components: [{ componentType: 'ProgressNode', kind: 'node' }],
  },
  source: `serve({
  ProgressNode: {
    execute: (input, ctx) => {
      ctx.emitEvent('progress', { done: 3, total: 10 });
      ctx.log('warn', 'retrying after a 429');
      return { output: { ok: true } };
    },
  },
});
`,
};

interface Frame {
  name: string;
  data: Record<string, unknown>;
}

/** Split an SSE body into frames, keeping the event name beside its payload. */
function frames(body: string): Frame[] {
  const out: Frame[] = [];
  for (const block of body.split('\n\n')) {
    let name = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) continue;
    out.push({ name, data: JSON.parse(data.join('\n')) as Record<string, unknown> });
  }
  return out;
}

let server: Server;
let base: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'heddle-plugin-streaming-'));
  // Both are required to reach this path at all: without the flag
  // `rejectRequestCode` refuses the body, and a submitted plugin has nowhere to
  // be written without a work directory.
  server = createServer({ allowRequestCode: true, workDir, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workDir, { recursive: true, force: true });
});

describe('what a submitted plugin reports reaches the caller stream', () => {
  it('carries an emitEvent and a log through to SSE frames', async () => {
    const res = await fetch(`${base}/v1/runs?stream=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flow: JSON.stringify(FLOW),
        plugins: [PLUGIN],
        inputs: { text: 'hello' },
      }),
    });

    expect(res.status).toBe(200);
    const all = frames(await res.text());

    // The run really finished, so an absent plugin frame below is a dropped
    // report rather than a run that never got that far.
    expect(all.map((f) => f.name)).toContain('flow_complete');

    // Namespaced by heddle from the component type it dispatched, which is why
    // the client can attribute it without trusting the plugin.
    expect(all.find((f) => f.name === 'plugin:ProgressNode:progress')?.data).toMatchObject({
      nodeName: 'p',
      nodeType: 'ProgressNode',
      data: { done: 3, total: 10 },
    });

    expect(all.find((f) => f.name === 'plugin_log')?.data).toMatchObject({
      nodeName: 'p',
      nodeType: 'ProgressNode',
      level: 'warn',
      message: 'retrying after a 429',
    });
  });
});
