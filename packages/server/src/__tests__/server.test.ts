import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';
import { isPubliclyBound } from '../config.js';

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

function agentFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'agent-flow',
    start_node: { $component_ref: 'start' },
    nodes: [
      { $component_ref: 'start' },
      { $component_ref: 'agent' },
      { $component_ref: 'end' },
    ],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_agent',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'agent' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'agent_to_end',
        from_node: { $component_ref: 'agent' },
        to_node: { $component_ref: 'end' },
      },
    ],
    $referenced_components: {
      start: { component_type: 'StartNode', id: 'start', name: 'start' },
      agent: {
        component_type: 'AgentNode',
        id: 'agent',
        name: 'agent',
        agent: {
          component_type: 'Agent',
          id: 'inner-agent',
          name: 'inner-agent',
          system_prompt: 'be helpful',
          llm_config: {
            component_type: 'OpenAiConfig',
            id: 'llm',
            name: 'openai',
            model_id: 'gpt-4o',
          },
        },
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

let server: Server;
let base: string;
let flowsRoot: string;
let outsideFile: string;

beforeAll(async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'heddle-server-test-'));
  flowsRoot = join(scratch, 'flows');
  mkdirSync(flowsRoot);
  writeFileSync(join(flowsRoot, 'simple.json'), JSON.stringify(simpleFlow()));

  outsideFile = join(scratch, 'outside.json');
  writeFileSync(outsideFile, JSON.stringify(simpleFlow()));
  symlinkSync(outsideFile, join(flowsRoot, 'escape.json'));

  server = createServer({ flowsRoot, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });
}

describe('GET /healthz', () => {
  it('reports ok', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
  });
});

describe('POST /v1/validate', () => {
  it('accepts an inline flow and describes the compiled graph', async () => {
    const res = await post('/v1/validate', { flow: simpleFlow() });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      valid: true,
      flow: 'test-flow',
      startNode: 'start',
      nodes: [
        { name: 'start', type: 'StartNode' },
        { name: 'end', type: 'EndNode' },
      ],
    });
  });

  it('accepts a flow submitted as YAML text', async () => {
    const yaml = [
      'component_type: Flow',
      'name: yaml-flow',
      'start_node:',
      '  $component_ref: start',
      'nodes:',
      '  - $component_ref: start',
      '  - $component_ref: end',
      'control_flow_connections:',
      '  - component_type: ControlFlowEdge',
      '    name: start_to_end',
      '    from_node: { $component_ref: start }',
      '    to_node: { $component_ref: end }',
      '$referenced_components:',
      '  start:',
      '    component_type: StartNode',
      '    id: start',
      '    name: start',
      '  end:',
      '    component_type: EndNode',
      '    id: end',
      '    name: end',
    ].join('\n');

    const res = await post('/v1/validate', { flow: yaml });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, flow: 'yaml-flow' });
  });

  it('validates a flow with an agent node without any API key', async () => {
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const res = await post('/v1/validate', { flow: agentFlow() });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ valid: true, flow: 'agent-flow' });
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it('reports a structured error for a flow with no start node', async () => {
    const broken = simpleFlow();
    (broken as { $referenced_components: Record<string, { component_type: string }> })
      .$referenced_components.start.component_type = 'EndNode';

    const res = await post('/v1/validate', { flow: broken });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toMatch(/SpecError|CompileError/);
    expect(body.error.message).toBeTruthy();
  });

  it('rejects a request naming neither flow nor flowPath', async () => {
    const res = await post('/v1/validate', {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('flow');
  });
});

describe('POST /v1/runs', () => {
  it('runs a flow and returns the final state', async () => {
    const res = await post('/v1/runs', {
      flow: simpleFlow(),
      inputs: { query: 'hello' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flow: 'test-flow',
      state: { query: 'hello' },
    });
  });

  it('rejects non-object inputs', async () => {
    const res = await post('/v1/runs', { flow: simpleFlow(), inputs: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rejects a body larger than the configured ceiling', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ flow: simpleFlow(), pad: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect(res.status).toBe(413);
  });

  it('rejects GET', async () => {
    const res = await fetch(`${base}/v1/runs`);
    expect(res.status).toBe(405);
  });
});

describe('POST /v1/runs?stream=true', () => {
  it('streams runner events as SSE frames in execution order', async () => {
    const res = await post('/v1/runs?stream=true', {
      flow: simpleFlow(),
      inputs: { query: 'streamed' },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

    expect(events).toEqual([
      'flow_start',
      'node_start',
      'node_complete',
      'node_start',
      'node_complete',
      'flow_complete',
    ]);

    const frames = text.trim().split('\n\n');
    const last = frames[frames.length - 1];
    const data = JSON.parse(last.split('\ndata: ')[1]);
    expect(data).toMatchObject({
      type: 'flow_complete',
      state: { query: 'streamed' },
    });
  });

  it('reports a bad flow as a 400, not as an SSE error frame', async () => {
    const res = await post('/v1/runs?stream=true', { flow: { component_type: 'Flow' } });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('security: tools directory is server-side only', () => {
  it('refuses a per-request toolsDir instead of silently ignoring it', async () => {
    const res = await post('/v1/runs', {
      flow: simpleFlow(),
      toolsDir: '/tmp/attacker-controlled',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('server-side configuration');
  });

  it('refuses a per-request flowsRoot', async () => {
    const res = await post('/v1/runs', { flow: simpleFlow(), flowsRoot: '/' });
    expect(res.status).toBe(400);
  });
});

describe('security: flowPath confinement', () => {
  it('loads a flow inside the configured root', async () => {
    const res = await post('/v1/validate', { flowPath: 'simple.json' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, flow: 'test-flow' });
  });

  it.each([
    ['../outside.json'],
    ['../../etc/passwd'],
    ['subdir/../../outside.json'],
  ])('rejects traversal via %s', async (path) => {
    const res = await post('/v1/validate', { flowPath: path });
    expect(res.status).toBe(404);
  });

  it('rejects an absolute path outside the root', async () => {
    const res = await post('/v1/validate', { flowPath: outsideFile });
    expect(res.status).toBe(404);
  });

  it('rejects a symlink inside the root that points outside it', async () => {
    const res = await post('/v1/validate', { flowPath: 'escape.json' });
    expect(res.status).toBe(404);
  });

  it('rejects flowPath entirely when no flows root is configured', async () => {
    const bare = createServer({ log: () => {} });
    await new Promise<void>((resolve) => bare.listen(0, '127.0.0.1', resolve));
    const address = bare.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flowPath: 'simple.json' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('flows root');
    } finally {
      await new Promise<void>((resolve) => bare.close(() => resolve()));
    }
  });
});

describe('security: bind address classification', () => {
  it('treats loopback as private and everything else as public', () => {
    expect(isPubliclyBound('127.0.0.1')).toBe(false);
    expect(isPubliclyBound('localhost')).toBe(false);
    expect(isPubliclyBound('::1')).toBe(false);
    expect(isPubliclyBound('0.0.0.0')).toBe(true);
    expect(isPubliclyBound('192.168.1.5')).toBe(true);
  });
});

describe('cancellation', () => {
  it('aborts the run when the client disconnects', async () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'heddle-tools-'));
    const marker = join(toolsDir, 'completed.marker');
    const toolPath = join(toolsDir, 'slow_tool.sh');
    writeFileSync(
      toolPath,
      `#!/usr/bin/env bash\ncat > /dev/null\nsleep 5\ntouch "${marker}"\necho '{"done": true}'\n`,
    );
    chmodSync(toolPath, 0o755);

    const toolFlow = {
      component_type: 'Flow',
      name: 'tool-flow',
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
    };

    const toolServer = createServer({ toolsDir, log: () => {} });
    await new Promise<void>((resolve) => toolServer.listen(0, '127.0.0.1', resolve));
    const address = toolServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const ac = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/runs?stream=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: toolFlow, inputs: {} }),
        signal: ac.signal,
      });
      expect(res.status).toBe(200);

      const draining = res.text();

      await new Promise((resolve) => setTimeout(resolve, 400));
      ac.abort();
      await expect(draining).rejects.toThrow();

      await new Promise((resolve) => setTimeout(resolve, 5200));
      const { existsSync } = await import('node:fs');
      expect(existsSync(marker)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => toolServer.close(() => resolve()));
    }
  }, 20_000);
});
