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

/**
 * A submitted plugin is two things: a manifest declaring what it provides, and
 * handler source calling `serve()`. The runtime that defines `serve` is
 * prepended by the server, so the source never imports anything — it runs from
 * a temp directory with no node_modules beside it.
 */
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

  // The in-process shape is not merely unsupported, it is the thing this
  // endpoint exists to refuse: importing it would run the caller's code inside
  // the server. The message has to say so, since the author's plugin is
  // otherwise perfectly valid heddle.
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
    // The process is started lazily, so this surfaces when the node runs
    // rather than at load. It is still the caller's fault, and PluginError
    // maps to 400.
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
});

// ---------------------------------------------------------------------------
// The property that lets one engine serve many callers.
// ---------------------------------------------------------------------------

describe('isolation between runs', () => {
  /** Plants whatever it is given on a global, and reports everything planted. */
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

  // The attack that succeeds against the in-process API, over HTTP.
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
    // A shared process would answer ["caller-one-secret"] here.
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

    // The server is still answering, which is the half that matters.
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

describe('specs cannot read the server environment', () => {
  /** A flow whose agent's llm_config is chosen by the caller. */
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

  // The reference is not restricted to model keys: any variable the process
  // holds can be named, and the flow chooses the URL it is sent to.
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
      // The value must not appear in the reply, even in an error.
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

      // Same shape either way, so the environment cannot be enumerated by
      // comparing responses. replaceAll, not replace: the message names the
      // variable more than once, and normalizing only the first occurrence
      // would compare two strings that still differ by name.
      expect(present.error.message.replaceAll('HEDDLE_PRESENT', 'X')).toBe(
        absent.error.message.replaceAll('DEFINITELY_NOT_SET_ANYWHERE', 'X'),
      );
    } finally {
      delete process.env.HEDDLE_PRESENT;
    }
  });

  it('still accepts a credential written into the spec', async () => {
    // Reaches the provider and fails on connection, not on the credential —
    // which is the point: the caller supplies their own key.
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
      // Points at a closed port: these tests assert which credential and URL
      // the engine *chooses*, and a chosen endpoint that answers would make
      // them depend on a live provider.
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
            // OpenAiConfig has no `url` field — agentspec drops it. Only
          // OpenAiCompatibleConfig can name an endpoint, so that is the type a
          // caller choosing one has to use, and the type the rule guards.
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

  // The hole this rule exists to close: a caller naming a destination and
  // letting the server attach its credential to the request.
  it('refuses a spec that chooses a url but supplies no key', async () => {
    const res = await post({
      flow: agentFlow({ url: 'http://127.0.0.1:9/attacker' }),
      inputs: { query: 'hi' },
    });

    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/has to supply the key/);
    expect(JSON.stringify(body)).not.toContain('operator-secret-key');
  });

  it('lets a spec that supplies its own key choose its own url', async () => {
    const res = await post({
      flow: agentFlow({ url: 'http://127.0.0.1:9/their-own', api_key: 'callers-own-key' }),
      inputs: { query: 'hi' },
    });
    const body = (await res.json()) as { error: { message: string } };
    // Reaches the provider and fails on the connection, not on the rule.
    expect(body.error.message).not.toMatch(/has to supply the key/);
  });

  it('supplies the credential to a spec that names neither', async () => {
    const res = await post({ flow: agentFlow({}), inputs: { query: 'hi' } });
    const body = (await res.json()) as { error: { message: string } };
    // Got as far as dialling the operator endpoint, which is what "supplied"
    // looks like from outside.
    expect(body.error.type ?? '').toBe('LLMError');
    expect(JSON.stringify(body)).not.toContain('operator-secret-key');
  });

  it('a server with no default credential is unchanged', async () => {
    // The main suite's server has none configured; a spec with a url and no
    // key is its caller's problem, not a refusal.
    const res = await post({
      flow: agentFlow({ url: 'http://127.0.0.1:9/x', api_key: 'k' }),
      inputs: { query: 'hi' },
    });
    expect(res.status).toBe(500);
  });
});
