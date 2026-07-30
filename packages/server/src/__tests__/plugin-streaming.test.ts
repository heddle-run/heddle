import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

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

    expect(all.map((f) => f.name)).toContain('flow_complete');

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
