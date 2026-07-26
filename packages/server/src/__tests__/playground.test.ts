/**
 * The playground surface: CORS, request-submitted tools and plugins, the
 * capabilities probe, and the concurrency ceiling.
 *
 * These exercise a server started with `allowRequestCode`, which is a
 * configuration nothing else in the test suite uses and nothing should run
 * outside a disposable container.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

const ORIGIN = 'https://heddle.run';

/** A flow whose single working node runs a tool named `echo_upper`. */
function toolFlow(toolName = 'echo_upper'): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'tool-flow',
    start_node: { $component_ref: 'start' },
    nodes: [
      { $component_ref: 'start' },
      { $component_ref: 'run' },
      { $component_ref: 'end' },
    ],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_run',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'run' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'run_to_end',
        from_node: { $component_ref: 'run' },
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
      run: {
        component_type: 'ToolNode',
        id: 'run',
        name: 'run',
        tool: {
          component_type: 'ServerTool',
          id: 'tool',
          name: toolName,
          description: 'uppercases text',
        },
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

/** A flow with one node of a custom type that only a plugin can provide. */
function pluginFlow(): Record<string, unknown> {
  return {
    component_type: 'Flow',
    name: 'plugin-flow',
    start_node: { $component_ref: 'start' },
    nodes: [
      { $component_ref: 'start' },
      { $component_ref: 'shout' },
      { $component_ref: 'end' },
    ],
    control_flow_connections: [
      {
        component_type: 'ControlFlowEdge',
        name: 'start_to_shout',
        from_node: { $component_ref: 'start' },
        to_node: { $component_ref: 'shout' },
      },
      {
        component_type: 'ControlFlowEdge',
        name: 'shout_to_end',
        from_node: { $component_ref: 'shout' },
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
      shout: {
        component_type: 'ShoutNode',
        id: 'shout',
        name: 'shout',
        component_plugin_name: 'test-plugin',
        component_plugin_version: '1.0.0',
      },
      end: { component_type: 'EndNode', id: 'end', name: 'end' },
    },
  };
}

/** A tool script: reads JSON on stdin, writes JSON on stdout. */
const ECHO_UPPER = `
read -r line
printf '%s' "$line" | tr '[:lower:]' '[:upper:]'
`;

const SHOUT_PLUGIN = `
export default {
  name: 'test-plugin',
  version: '1.0.0',
  nodes: [
    {
      componentType: 'ShoutNode',
      createExecutor() {
        return {
          execute(input) {
            return { output: { text: String(input.text ?? '').toUpperCase() } };
          },
        };
      },
    },
  ],
};
`;

let server: Server;
let base: string;
let workDir: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'heddle-playground-test-'));

  server = createServer({
    allowRequestCode: true,
    corsOrigins: [ORIGIN],
    workDir,
    maxConcurrentRuns: 2,
    log: () => {},
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('CORS', () => {
  it('answers a preflight from a configured origin', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'OPTIONS',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('withholds the allow header from an origin that is not configured', async () => {
    const res = await fetch(`${base}/v1/runs`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  // A configured origin must match exactly: a prefix check would admit
  // heddle.run.attacker.example, which is a different site.
  it('does not admit an origin that merely starts with a configured one', async () => {
    const res = await fetch(`${base}/healthz`, {
      headers: { origin: `${ORIGIN}.attacker.example` },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('carries the headers on real responses, not just preflights', async () => {
    const res = await post('/v1/validate', { flow: toolFlow() }, { origin: ORIGIN });
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });

  it('carries the headers on error responses too', async () => {
    const res = await post('/v1/validate', {}, { origin: ORIGIN });
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
  });
});

describe('GET /v1/capabilities', () => {
  it('reports what the server accepts', async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      allowRequestCode: true,
      acceptsFlowPath: false,
      sandbox: null,
      tools: [],
    });
    expect(body.limits).toMatchObject({ maxConcurrentRuns: 2 });
    expect(body.version).toBeTruthy();
  });

  it('does not disclose filesystem paths', async () => {
    const res = await fetch(`${base}/v1/capabilities`);
    const text = await res.text();
    expect(text).not.toContain(workDir);
    expect(text).not.toContain(tmpdir());
  });

  it('rejects POST', async () => {
    const res = await post('/v1/capabilities', {});
    expect(res.status).toBe(405);
  });
});

describe('request-submitted tools', () => {
  it('runs a tool supplied with the request', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER, interpreter: 'sh' }],
    });
    expect(res.status).toBe(200);
    // The runner accumulates state rather than replacing it, so the start
    // node's `text` is still there alongside the tool's uppercased output.
    expect(await res.json()).toMatchObject({
      flow: 'tool-flow',
      state: { TEXT: 'HELLO' },
    });
  });

  it('honours a shebang written into the source', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      inputs: { text: 'shebang' },
      tools: [{ name: 'echo_upper', source: `#!/bin/sh\n${ECHO_UPPER}` }],
    });
    expect(res.status).toBe(200);
  });

  it('still refuses a flow naming a tool that was not submitted', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow('absent_tool'),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('absent_tool');
  });

  it('leaves nothing behind on disk once the run is over', async () => {
    const before = readdirSync(workDir);
    await post('/v1/runs', {
      flow: toolFlow(),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER }],
    });
    expect(readdirSync(workDir)).toEqual(before);
  });

  it('cleans up after a run that failed', async () => {
    const before = readdirSync(workDir);
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: 'exit 1' }],
    });
    expect(res.status).toBe(500);
    expect(readdirSync(workDir)).toEqual(before);
  });
});

describe('request-submitted plugins', () => {
  it('runs a node type that only the submitted plugin provides', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'quiet' },
      plugins: [{ name: 'shout', source: SHOUT_PLUGIN }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      flow: 'plugin-flow',
      state: { text: 'QUIET' },
    });
  });

  it('validates a flow using a submitted plugin', async () => {
    const res = await post('/v1/validate', {
      flow: pluginFlow(),
      plugins: [{ name: 'shout', source: SHOUT_PLUGIN }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, flow: 'plugin-flow' });
  });

  it('rejects the same flow when the plugin is absent', async () => {
    const res = await post('/v1/validate', { flow: pluginFlow() });
    expect(res.status).toBe(400);
  });

  it('reports a plugin that fails to import as a bad request', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      plugins: [{ name: 'broken', source: 'this is not javascript {{{' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('PluginError');
  });

  it('reports a plugin declaring nothing as a bad request', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      plugins: [{ name: 'empty', source: 'export default { name: "x", version: "1" };' }],
    });
    expect(res.status).toBe(400);
  });
});

describe('submitted code is validated before it reaches disk', () => {
  const cases: Array<[string, unknown]> = [
    ['a name that traverses', { name: '../escape', source: 'echo hi' }],
    ['a name with a slash', { name: 'nested/tool', source: 'echo hi' }],
    ['a name that is only dots', { name: '..', source: 'echo hi' }],
    ['an absolute name', { name: '/etc/passwd', source: 'echo hi' }],
    ['a name with a null byte', { name: 'ok bad', source: 'echo hi' }],
    ['an empty name', { name: '', source: 'echo hi' }],
    ['a missing source', { name: 'tool' }],
    ['a non-string source', { name: 'tool', source: 42 }],
  ];

  for (const [label, tool] of cases) {
    it(`rejects ${label}`, async () => {
      const res = await post('/v1/runs', { flow: toolFlow(), tools: [tool] });
      expect(res.status).toBe(400);
    });
  }

  it('rejects an unknown interpreter', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      tools: [{ name: 'echo_upper', source: ECHO_UPPER, interpreter: 'perl' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('interpreter');
  });

  it('rejects duplicate names', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      tools: [
        { name: 'echo_upper', source: ECHO_UPPER },
        { name: 'echo_upper', source: ECHO_UPPER },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('rejects more tools than the limit allows', async () => {
    const tools = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      source: 'echo {}',
    }));
    const res = await post('/v1/runs', { flow: toolFlow(), tools });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('at most');
  });

  it('rejects source over the byte ceiling', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      tools: [{ name: 'big', source: 'x'.repeat(300 * 1024) }],
    });
    expect(res.status).toBe(400);
  });

  it('rejects tools that is not an array', async () => {
    const res = await post('/v1/runs', { flow: toolFlow(), tools: 'nope' });
    expect(res.status).toBe(400);
  });

  it('never creates a directory for a rejected submission', async () => {
    const before = readdirSync(workDir);
    await post('/v1/runs', {
      flow: toolFlow(),
      tools: [{ name: '../escape', source: 'echo hi' }],
    });
    expect(readdirSync(workDir)).toEqual(before);
    expect(existsSync(join(workDir, '..', 'escape'))).toBe(false);
  });
});

describe('malformed flows', () => {
  // The deserializer crashes on a flow missing a section it assumes exists,
  // and the raw "Cannot read properties of undefined" is useless to whoever
  // wrote the document.
  it('explains a flow that is missing its sections', async () => {
    const res = await post('/v1/validate', {
      flow: 'component_type: Flow\nname: broken\n',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('SpecError');
    expect(body.error.message).toContain('Agent Spec flow');
    expect(body.error.message).toContain('start_node');
  });

  it('passes a YAML syntax error through, which is already clear', async () => {
    const res = await post('/v1/validate', { flow: 'not yaml: [ }' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('line 1');
  });
});

describe('server-side configuration is still not request-settable', () => {
  it('rejects toolsDir', async () => {
    const res = await post('/v1/runs', { flow: toolFlow(), toolsDir: '/etc' });
    expect(res.status).toBe(400);
  });

  it('rejects flowsRoot', async () => {
    const res = await post('/v1/runs', { flow: toolFlow(), flowsRoot: '/' });
    expect(res.status).toBe(400);
  });
});

describe('a server without --allow-request-code', () => {
  let plain: Server;
  let plainBase: string;

  beforeAll(async () => {
    plain = createServer({ log: () => {} });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const address = plain.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    plainBase = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => plain.close(() => resolve()));
  });

  function plainPost(path: string, body: unknown) {
    return fetch(`${plainBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // Refused rather than ignored: a caller whose plugin was silently dropped
  // would see an unknown-component-type failure and no reason for it.
  it('refuses submitted tools with an explanation', async () => {
    const res = await plainPost('/v1/runs', {
      flow: toolFlow(),
      tools: [{ name: 'echo_upper', source: ECHO_UPPER }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('allow-request-code');
  });

  it('refuses submitted plugins on the validate endpoint too', async () => {
    const res = await plainPost('/v1/validate', {
      flow: pluginFlow(),
      plugins: [{ name: 'shout', source: SHOUT_PLUGIN }],
    });
    expect(res.status).toBe(400);
  });

  it('sends no CORS headers', async () => {
    const res = await fetch(`${plainBase}/healthz`, { headers: { origin: ORIGIN } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('reports the restriction through capabilities', async () => {
    const res = await fetch(`${plainBase}/v1/capabilities`);
    expect(await res.json()).toMatchObject({ allowRequestCode: false });
  });
});

describe('concurrency ceiling', () => {
  it('refuses runs beyond the limit with a 429', async () => {
    // Three at once against a limit of two. The tool sleeps so the first
    // requests are still holding their slots when the third arrives.
    const slow = {
      flow: toolFlow(),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: `sleep 1\n${ECHO_UPPER}` }],
    };

    const responses = await Promise.all([
      post('/v1/runs', slow),
      post('/v1/runs', slow),
      post('/v1/runs', slow),
    ]);

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(2);
  });

  it('releases slots once runs finish', async () => {
    const res = await post('/v1/runs', {
      flow: toolFlow(),
      inputs: { text: 'after' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER }],
    });
    expect(res.status).toBe(200);
  });
});

describe('streaming with submitted code', () => {
  it('streams events and cleans up afterwards', async () => {
    const before = readdirSync(workDir);
    const res = await post('/v1/runs?stream=true', {
      flow: toolFlow(),
      inputs: { text: 'stream' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('event: flow_start');
    expect(text).toContain('event: flow_complete');
    expect(readdirSync(workDir)).toEqual(before);
  });

  it('reports a broken plugin as a 400 rather than opening a stream', async () => {
    const res = await post('/v1/runs?stream=true', {
      flow: pluginFlow(),
      plugins: [{ name: 'broken', source: 'syntax ((( error' }],
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});
