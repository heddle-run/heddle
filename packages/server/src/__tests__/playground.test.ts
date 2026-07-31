import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createServer } from '../server.js';

const ORIGIN = 'https://heddle.run';

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

const ECHO_UPPER = `
read -r line
printf '%s' "$line" | tr '[:lower:]' '[:upper:]'
`;

const SHOUT_MANIFEST = {
  name: 'test-plugin',
  version: '1.0.0',
  components: [{ componentType: 'ShoutNode' }],
};

const SHOUT_SOURCE = `
serve({
  ShoutNode: {
    execute: (input) => ({ output: { text: String(input.text ?? '').toUpperCase() } }),
  },
});
`;

const shoutPlugin = () => ({
  name: 'shout',
  manifest: SHOUT_MANIFEST,
  source: SHOUT_SOURCE,
});

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
      plugins: [shoutPlugin()],
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
      plugins: [shoutPlugin()],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, flow: 'plugin-flow' });
  });

  it('rejects the same flow when the plugin is absent', async () => {
    const res = await post('/v1/validate', { flow: pluginFlow() });
    expect(res.status).toBe(400);
  });

  it('refuses a plugin written against the in-process API', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      plugins: [
        { name: 'legacy', source: 'export default { name: "x", version: "1", nodes: [] };' },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('manifest');
    expect(body.error.message).toMatch(/would run\s+inside the server|run out of process/);
  });

  it('rejects a manifest that declares no components', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      plugins: [
        { name: 'empty', manifest: { name: 'x', version: '1', components: [] }, source: 'serve({});' },
      ],
    });
    expect(res.status).toBe(400);
  });

  it('reports a plugin whose source will not run', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'x' },
      plugins: [{ name: 'broken', manifest: SHOUT_MANIFEST, source: 'this is not javascript {{{' }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('PluginError');
  });

  it('gives the plugin none of the server environment', async () => {
    process.env.HEDDLE_SERVER_SECRET = 'do-not-leak';
    try {
      const res = await post('/v1/runs', {
        flow: pluginFlow(),
        inputs: { text: 'x' },
        plugins: [
          {
            name: 'peek',
            manifest: SHOUT_MANIFEST,
            source: `serve({ ShoutNode: { execute: () => ({
              output: { text: String(process.env.HEDDLE_SERVER_SECRET ?? 'absent') } }) } });`,
          },
        ],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ state: { text: 'absent' } });
    } finally {
      delete process.env.HEDDLE_SERVER_SECRET;
    }
  });

  const toolCaller = (capabilities?: string[]) => ({
    name: 'caller',
    manifest: { ...SHOUT_MANIFEST, ...(capabilities ? { capabilities } : {}) },
    source: `
      serve({
        ShoutNode: {
          execute: async (input, ctx) => {
            try {
              const result = await ctx.runTool('echo_upper', { text: input.text });
              return { output: { text: JSON.stringify(result) } };
            } catch (err) {
              return { output: { text: 'refused: ' + err.message } };
            }
          },
        },
      });
    `,
  });

  it('lets a submitted plugin reach the tools submitted alongside it', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER, interpreter: 'sh' }],
      plugins: [toolCaller(['runTool'])],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      state: { text: '{"TEXT":"HELLO"}' },
    });
  });

  it('refuses a plugin the tools it never declared it would use', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'hello' },
      tools: [{ name: 'echo_upper', source: ECHO_UPPER, interpreter: 'sh' }],
      plugins: [toolCaller()],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { text: string } };
    expect(body.state.text).toMatch(/^refused: /);
    expect(body.state.text).toMatch(/"runTool" is not granted to this plugin/);
    expect(body.state.text).toMatch(/Add it to "capabilities" in the manifest/);
  });

  it('rejects a manifest asking for a capability heddle does not serve', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'hello' },
      plugins: [
        {
          name: 'greedy',
          manifest: { ...SHOUT_MANIFEST, capabilities: ['getState'] },
          source: SHOUT_SOURCE,
        },
      ],
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/"getState", which heddle does not serve/);
    expect(body.error.message).toMatch(/It serves: runTool/);
  });
});

describe('isolation between runs', () => {
  const planter = (name: string) => ({
    name,
    manifest: { ...SHOUT_MANIFEST, components: [{ componentType: 'ShoutNode' }] },
    source: `
      globalThis.__planted ??= [];
      serve({
        ShoutNode: {
          execute: (input) => {
            if (input.text) globalThis.__planted.push(input.text);
            return { output: { text: JSON.stringify(globalThis.__planted) } };
          },
        },
      });
    `,
  });

  it('does not carry one caller state into the next request', async () => {
    const first = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'caller-one-secret' },
      plugins: [planter('a')],
    });
    expect(first.status).toBe(200);
    expect((await first.json()) as Record<string, unknown>).toMatchObject({
      state: { text: '["caller-one-secret"]' },
    });

    const second = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: {},
      plugins: [planter('b')],
    });
    expect(second.status).toBe(200);
    expect((await second.json()) as Record<string, unknown>).toMatchObject({
      state: { text: '[]' },
    });
  });

  it('keeps concurrent runs from seeing each other', async () => {
    const [a, b] = await Promise.all([
      post('/v1/runs', {
        flow: pluginFlow(),
        inputs: { text: 'alice-private' },
        plugins: [planter('a')],
      }),
      post('/v1/runs', {
        flow: pluginFlow(),
        inputs: { text: 'bob-private' },
        plugins: [planter('b')],
      }),
    ]);

    expect(await a.json()).toMatchObject({ state: { text: '["alice-private"]' } });
    expect(await b.json()).toMatchObject({ state: { text: '["bob-private"]' } });
  });

  it('survives a plugin that kills its own process', async () => {
    const res = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'x' },
      plugins: [
        {
          name: 'suicide',
          manifest: SHOUT_MANIFEST,
          source: `serve({ ShoutNode: { execute: () => { process.exit(1); } } });`,
        },
      ],
    });
    expect(res.status).toBe(400);

    const after = await post('/v1/runs', {
      flow: pluginFlow(),
      inputs: { text: 'still here' },
      plugins: [shoutPlugin()],
    });
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({ state: { text: 'STILL HERE' } });
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
      plugins: [shoutPlugin()],
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

describe('specs cannot read the server environment', () => {
  function agentFlowWith(llmConfig: Record<string, unknown>): Record<string, unknown> {
    return {
      component_type: 'Flow',
      name: 'env-probe',
      start_node: { $component_ref: 's' },
      nodes: [{ $component_ref: 's' }, { $component_ref: 'a' }, { $component_ref: 'e' }],
      control_flow_connections: [
        {
          component_type: 'ControlFlowEdge',
          name: 'x',
          from_node: { $component_ref: 's' },
          to_node: { $component_ref: 'a' },
        },
        {
          component_type: 'ControlFlowEdge',
          name: 'y',
          from_node: { $component_ref: 'a' },
          to_node: { $component_ref: 'e' },
        },
      ],
      $referenced_components: {
        s: { component_type: 'StartNode', id: 's', name: 's' },
        a: {
          component_type: 'AgentNode',
          id: 'a',
          name: 'a',
          agent: {
            component_type: 'Agent',
            id: 'ia',
            name: 'ia',
            system_prompt: 'x',
            llm_config: llmConfig,
          },
        },
        e: { component_type: 'EndNode', id: 'e', name: 'e' },
      },
    };
  }

  it('refuses to dereference an environment variable', async () => {
    process.env.HEDDLE_UNRELATED_SECRET = 'aws-style-credential';
    try {
      const res = await post('/v1/runs', {
        flow: agentFlowWith({
          component_type: 'OpenAiConfig',
          id: 'l',
          name: 'l',
          model_id: 'gpt-4o',
          url: 'http://127.0.0.1:9/never-reached',
          api_key: '$HEDDLE_UNRELATED_SECRET',
        }),
        inputs: { query: 'hi' },
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('does not resolve');
      expect(JSON.stringify(body)).not.toContain('aws-style-credential');
    } finally {
      delete process.env.HEDDLE_UNRELATED_SECRET;
    }
  });

  it('does not reveal whether a variable exists', async () => {
    const forAbsent = await post('/v1/runs', {
      flow: agentFlowWith({
        component_type: 'OpenAiConfig',
        id: 'l',
        name: 'l',
        model_id: 'gpt-4o',
        api_key: '$DEFINITELY_NOT_SET_ANYWHERE',
      }),
      inputs: { query: 'hi' },
    });
    const absent = (await forAbsent.json()) as { error: { message: string } };

    process.env.HEDDLE_PRESENT = 'value';
    try {
      const forPresent = await post('/v1/runs', {
        flow: agentFlowWith({
          component_type: 'OpenAiConfig',
          id: 'l',
          name: 'l',
          model_id: 'gpt-4o',
          api_key: '$HEDDLE_PRESENT',
        }),
        inputs: { query: 'hi' },
      });
      const present = (await forPresent.json()) as { error: { message: string } };

      expect(present.error.message.replaceAll('HEDDLE_PRESENT', 'X')).toBe(
        absent.error.message.replaceAll('DEFINITELY_NOT_SET_ANYWHERE', 'X'),
      );
    } finally {
      delete process.env.HEDDLE_PRESENT;
    }
  });

  it('still accepts a credential written into the spec', async () => {
    const res = await post('/v1/runs', {
      flow: agentFlowWith({
        component_type: 'OpenAiConfig',
        id: 'l',
        name: 'l',
        model_id: 'gpt-4o',
        url: 'http://127.0.0.1:9/unreachable',
        api_key: 'sk-callers-own-key',
      }),
      inputs: { query: 'hi' },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toContain('does not resolve');
  });
});

describe('the operator credential is bound to the operator endpoint', () => {
  let withKey: Server;
  let withKeyBase: string;

  beforeAll(async () => {
    withKey = createServer({
      allowRequestCode: true,
      defaultLlmKey: 'operator-secret-key',
      defaultLlmUrl: 'http://127.0.0.1:9/operator',
      log: () => {},
    });
    await new Promise<void>((r) => withKey.listen(0, '127.0.0.1', r));
    const a = withKey.address();
    withKeyBase = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => withKey.close(() => r()));
  });

  function agentFlow(llm: Record<string, unknown>): Record<string, unknown> {
    return {
      component_type: 'Flow',
      name: 'ask',
      start_node: { $component_ref: 's' },
      nodes: [{ $component_ref: 's' }, { $component_ref: 'a' }, { $component_ref: 'e' }],
      control_flow_connections: [
        { component_type: 'ControlFlowEdge', name: 'x', from_node: { $component_ref: 's' }, to_node: { $component_ref: 'a' } },
        { component_type: 'ControlFlowEdge', name: 'y', from_node: { $component_ref: 'a' }, to_node: { $component_ref: 'e' } },
      ],
      $referenced_components: {
        s: { component_type: 'StartNode', id: 's', name: 's' },
        a: {
          component_type: 'AgentNode', id: 'a', name: 'a',
          agent: {
            component_type: 'Agent', id: 'ia', name: 'ia', system_prompt: 'x',
          llm_config: {
            component_type: llm.url ? 'OpenAiCompatibleConfig' : 'OpenAiConfig',
            id: 'l', name: 'l', model_id: 'm', ...llm,
          },
          },
        },
        e: { component_type: 'EndNode', id: 'e', name: 'e' },
      },
    };
  }

  const post = (body: unknown) =>
    fetch(`${withKeyBase}/v1/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('refuses a spec that chooses a url but supplies no key', async () => {
    // A *public* endpoint, so this exercises the credential rule rather than the
    // egress one. The operator's key is bound to the operator's endpoint: a spec
    // that chooses where requests go has to bring its own key.
    const res = await post({
      flow: agentFlow({ url: 'https://attacker.example/v1' }),
      inputs: { query: 'hi' },
    });

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/has to supply the key/);
    expect(JSON.stringify(body)).not.toContain('operator-secret-key');
  });

  it('refuses a spec that points at this network at all', async () => {
    // Refused on the destination, before any question of credentials. Loopback
    // is this server's own unauthenticated API; the same rule covers
    // 169.254.169.254 and the RFC1918 ranges.
    const res = await post({
      flow: agentFlow({ url: 'http://127.0.0.1:9/attacker', api_key: 'sk-theirs' }),
      inputs: { query: 'hi' },
    });

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/loopback, link-local or private/);
    expect(JSON.stringify(body)).not.toContain('operator-secret-key');
  });

  it('lets a spec that supplies its own key choose its own url', async () => {
    const res = await post({
      flow: agentFlow({ url: 'http://127.0.0.1:9/their-own', api_key: 'callers-own-key' }),
      inputs: { query: 'hi' },
    });
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).not.toMatch(/has to supply the key/);
  });

  it('supplies the credential to a spec that names neither', async () => {
    const res = await post({ flow: agentFlow({}), inputs: { query: 'hi' } });
    const body = (await res.json()) as { error: { message: string; type?: string } };
    expect(body.error.type ?? '').toBe('LLMError');
    expect(JSON.stringify(body)).not.toContain('operator-secret-key');
  });

  it('a server with no default credential is unchanged', async () => {
    const res = await post({
      flow: agentFlow({ url: 'http://127.0.0.1:9/x', api_key: 'k' }),
      inputs: { query: 'hi' },
    });
    expect(res.status).toBe(500);
  });
});
