import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server.js';
import type { StartedServer } from '../server.js';

function slowToolFixture(seconds: number): {
  toolsDir: string;
  flow: Record<string, unknown>;
} {
  const toolsDir = mkdtempSync(join(tmpdir(), 'heddle-drain-tools-'));
  const toolPath = join(toolsDir, 'slow_tool.sh');
  writeFileSync(
    toolPath,
    `#!/usr/bin/env bash\ncat > /dev/null\nsleep ${seconds}\necho '{"done": true}'\n`,
  );
  chmodSync(toolPath, 0o755);

  return {
    toolsDir,
    flow: {
      component_type: 'Flow',
      name: 'slow-flow',
      start_node: { $component_ref: 'start' },
      nodes: [
        { $component_ref: 'start' },
        { $component_ref: 'slow' },
        { $component_ref: 'end' },
      ],
      control_flow_connections: [
        {
          component_type: 'ControlFlowEdge',
          name: 'start_to_slow',
          from_node: { $component_ref: 'start' },
          to_node: { $component_ref: 'slow' },
        },
        {
          component_type: 'ControlFlowEdge',
          name: 'slow_to_end',
          from_node: { $component_ref: 'slow' },
          to_node: { $component_ref: 'end' },
        },
      ],
      $referenced_components: {
        start: { component_type: 'StartNode', id: 'start', name: 'start' },
        slow: {
          component_type: 'ToolNode',
          id: 'slow',
          name: 'slow',
          tool: {
            component_type: 'ServerTool',
            id: 'slow_tool',
            name: 'slow_tool',
            description: 'sleeps',
          },
        },
        end: { component_type: 'EndNode', id: 'end', name: 'end' },
      },
    },
  };
}

async function startHeldRun(base: string, flow: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`${base}/v1/runs?stream=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow, inputs: {} }),
  });
  expect(res.status).toBe(200);

  for (let i = 0; i < 100; i++) {
    const metrics = await fetch(`${base}/metrics`).then((r) => r.text());
    if (/^heddle_active_runs 1$/m.test(metrics)) return res;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run never registered as in flight');
}

function simpleFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'test-flow',
    start_node: { $component_ref: 'start' },
    nodes: [{ $component_ref: 'start' }, { $component_ref: 'end' }],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_end',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'end' },
      },
    ],
    $referenced_components: {
      start: {
        component_type: 'StartNode',
        id: 'start',
        name: 'start',
        outputs: [{ title: 'query', type: 'string' }],
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

async function withServer(
  options: Parameters<typeof startServer>[0],
  fn: (started: StartedServer, base: string) => Promise<void>,
): Promise<void> {
  const started = await startServer({ host: '127.0.0.1', port: 0, log: () => {}, ...options });
  try {
    await fn(started, `http://127.0.0.1:${started.port}`);
  } finally {
    await started.close();
  }
}

function parseMetrics(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue;
    const [name, value] = line.split(' ');
    out[name] = Number(value);
  }
  return out;
}

describe('GET /metrics', () => {
  it('exposes the autoscaling signals in Prometheus text format', async () => {
    await withServer({ maxConcurrentRuns: 8 }, async (_started, base) => {
      const res = await fetch(`${base}/metrics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/plain');

      const body = await res.text();
      expect(body).toContain('# TYPE heddle_active_runs gauge');
      expect(body).toContain('# TYPE heddle_runs_accepted_total counter');

      const m = parseMetrics(body);
      expect(m.heddle_active_runs).toBe(0);
      expect(m.heddle_max_concurrent_runs).toBe(8);
      expect(m.heddle_run_saturation).toBe(0);
      expect(m.process_resident_memory_bytes).toBeGreaterThan(0);
    });
  });

  it('counts accepted runs and reports saturation against the ceiling', async () => {
    await withServer({ maxConcurrentRuns: 4 }, async (_started, base) => {
      const run = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: simpleFlow(), inputs: { query: 'hi' } }),
      });
      expect(run.status).toBe(200);

      const m = parseMetrics(await (await fetch(`${base}/metrics`)).text());
      expect(m.heddle_runs_accepted_total).toBe(1);
      expect(m.heddle_active_runs).toBe(0);
      expect(m.heddle_run_saturation).toBe(0);
    });
  });

  it('counts runs rejected at the ceiling, so 429s are visible to a scaler', async () => {
    await withServer({ maxConcurrentRuns: 0 }, async (_started, base) => {
      const res = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: simpleFlow(), inputs: {} }),
      });
      expect(res.status).toBe(429);

      const m = parseMetrics(await (await fetch(`${base}/metrics`)).text());
      expect(m.heddle_runs_rejected_total).toBe(1);
      expect(m.heddle_runs_accepted_total).toBe(0);
    });
  });
});

describe('readiness', () => {
  it('reports 503 while draining, so the pod leaves the Service endpoints', async () => {
    const { toolsDir, flow } = slowToolFixture(3);
    await withServer({ toolsDir, drainTimeout: 20_000 }, async (started, base) => {
      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toMatchObject({ status: 'ok' });

      const held = await startHeldRun(base, flow);
      const draining = started.drain();

      const probe = await fetch(`${base}/readyz`);
      expect(probe.status).toBe(503);
      expect(await probe.json()).toMatchObject({ status: 'draining' });

      await held.text();
      await draining;
    });
  }, 30_000);

  it('stays ready at the concurrency ceiling — saturation is not unhealthiness', async () => {
    await withServer({ maxConcurrentRuns: 0 }, async (_started, base) => {
      const refused = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: simpleFlow(), inputs: {} }),
      });
      expect(refused.status).toBe(429);

      const ready = await fetch(`${base}/readyz`);
      expect(ready.status).toBe(200);
    });
  });

  it('liveness stays ok regardless', async () => {
    await withServer({}, async (_started, base) => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'ok' });
    });
  });
});

describe('graceful drain', () => {
  it('lets an in-flight streaming run finish instead of cutting it', async () => {
    const started = await startServer({
      host: '127.0.0.1',
      port: 0,
      log: () => {},
      drainTimeout: 10_000,
    });
    const base = `http://127.0.0.1:${started.port}`;

    try {
      const res = await fetch(`${base}/v1/runs?stream=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: simpleFlow(), inputs: { query: 'streamed' } }),
      });
      expect(res.status).toBe(200);

      const draining = started.drain();
      const text = await res.text();
      await draining;

      expect(text).toContain('event: flow_complete');
      const frames = text.trim().split('\n\n');
      const data = JSON.parse(frames[frames.length - 1].split('\ndata: ')[1]);
      expect(data).toMatchObject({ type: 'flow_complete', state: { query: 'streamed' } });
    } finally {
      await started.close();
    }
  });

  it('refuses new runs with 503 once draining has begun', async () => {
    const { toolsDir, flow } = slowToolFixture(3);
    await withServer({ toolsDir, drainTimeout: 20_000 }, async (started, base) => {
      const held = await startHeldRun(base, flow);
      const draining = started.drain();

      const late = await fetch(`${base}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: simpleFlow(), inputs: {} }),
      });
      expect(late.status).toBe(503);
      expect(await late.json()).toMatchObject({ error: { type: 'Draining' } });

      await held.text();
      await draining;
    });
  }, 30_000);

  it('waits for a slow in-flight run rather than the deadline', async () => {
    const { toolsDir, flow } = slowToolFixture(3);
    await withServer({ toolsDir, drainTimeout: 30_000 }, async (started, base) => {
      const held = await startHeldRun(base, flow);

      const before = process.hrtime.bigint();
      const draining = started.drain();
      const text = await held.text();
      await draining;
      const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;

      expect(text).toContain('event: flow_complete');
      expect(elapsedMs).toBeGreaterThan(1_000);
      expect(elapsedMs).toBeLessThan(20_000);
    });
  }, 40_000);

  it('resolves promptly when nothing is in flight', async () => {
    const started = await startServer({
      host: '127.0.0.1',
      port: 0,
      log: () => {},
      drainTimeout: 30_000,
    });
    const before = process.hrtime.bigint();
    await started.drain();
    const elapsedMs = Number(process.hrtime.bigint() - before) / 1e6;

    expect(elapsedMs).toBeLessThan(2_000);
    await started.close();
  });
});
