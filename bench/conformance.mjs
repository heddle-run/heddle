/**
 * Does heddle-server actually behave the same on another runtime?
 *
 * The benchmark answers "is Bun faster". This answers the question that has to
 * come first, and it is deliberately black-box: it spawns the built server the
 * way a container does, then drives its real HTTP surface. Nothing is imported,
 * so whatever the server is executed by is what is under test.
 *
 * The checks are not a sample of the API. They are the places where a runtime
 * substitution is most likely to break something quietly:
 *
 *   - node:http request and response semantics, including SSE framing
 *   - child_process.spawn with piped stdin/stdout, which is every tool call
 *   - large subprocess output, where stream chunking differs between runtimes
 *   - the plugin RPC channel, a long-lived subprocess speaking newline JSON
 *   - SIGTERM handling and the drain sequence a rolling deploy depends on
 *   - AbortSignal.any/timeout, which the runner composes per run
 *
 * Always run this under Node, whichever runtime is under test:
 *
 *   node bench/conformance.mjs [--runtime node|bun|both]
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_ENTRY = resolve(ROOT, 'packages/server/dist/heddle-server.js');

const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'both' },
    port: { type: 'string', default: '4402' },
    'llm-port': { type: 'string', default: '4403' },
  },
});

const PORT = Number(values.port);
const LLM_PORT = Number(values['llm-port']);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Flow fixtures
// ---------------------------------------------------------------------------

const simpleFlow = () => ({
  component_type: 'Flow',
  name: 'conformance-simple',
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
});

const toolFlow = (toolName) => ({
  component_type: 'Flow',
  name: 'conformance-tool',
  start_node: { $component_ref: 'start' },
  nodes: [
    { $component_ref: 'start' },
    { $component_ref: 'call' },
    { $component_ref: 'end' },
  ],
  control_flow_connections: [
    {
      component_type: 'ControlFlowEdge',
      name: 'start_to_call',
      from_node: { $component_ref: 'start' },
      to_node: { $component_ref: 'call' },
    },
    {
      component_type: 'ControlFlowEdge',
      name: 'call_to_end',
      from_node: { $component_ref: 'call' },
      to_node: { $component_ref: 'end' },
    },
  ],
  $referenced_components: {
    start: { component_type: 'StartNode', id: 'start', name: 'start' },
    call: {
      component_type: 'ToolNode',
      id: 'call',
      name: 'call',
      tool: {
        component_type: 'ServerTool',
        id: toolName,
        name: toolName,
        description: 'conformance tool',
      },
    },
    end: { component_type: 'EndNode', id: 'end', name: 'end' },
  },
});

const pluginFlow = () => ({
  component_type: 'Flow',
  name: 'conformance-plugin',
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
      component_plugin_name: 'conformance-plugin',
      component_plugin_version: '1.0.0',
    },
    end: { component_type: 'EndNode', id: 'end', name: 'end' },
  },
});

const shoutPlugin = () => ({
  name: 'shout',
  manifest: {
    name: 'conformance-plugin',
    version: '1.0.0',
    components: [{ componentType: 'ShoutNode' }],
  },
  source: `
serve({
  ShoutNode: {
    execute: (input) => ({ output: { text: String(input.text ?? '').toUpperCase() } }),
  },
});
`,
});

/** The agent flow the benchmark uses, pointed at this suite's stub port. */
async function agentFlow() {
  const { readFile } = await import('node:fs/promises');
  const flow = JSON.parse(
    await readFile(resolve(HERE, 'flows/agent.json'), 'utf-8'),
  );
  const agent =
    flow.$referenced_components['b1000000-0000-4000-8000-000000000003'].agent;
  agent.llm_config.url = `http://127.0.0.1:${LLM_PORT}/v1`;
  return flow;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function startFakeLlm() {
  const proc = spawn(
    process.execPath,
    [resolve(HERE, 'fake-llm.mjs'), '--port', String(LLM_PORT)],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((res, rej) => {
    proc.stdout.once('data', () => res(proc));
    proc.once('error', rej);
  });
}

function startServer(runtime, workDir, toolsDir) {
  const argv = [
    SERVER_ENTRY,
    '--port', String(PORT),
    '--host', '127.0.0.1',
    '--allow-request-code',
    '--work-dir', workDir,
    '--tools-dir', toolsDir,
    '--max-concurrent', '8',
    '--timeout', '30000',
    '--drain-timeout', '15000',
  ];
  return spawn(runtime, argv, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

async function waitForHealth(deadlineMs = 30_000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return void (await res.text());
    } catch {
      /* not listening yet */
    }
    if (Date.now() - started > deadlineMs) throw new Error('server never came up');
    await sleep(10);
  }
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
}

/** Read an SSE body into a list of {event, data} frames. */
async function readSse(res) {
  const text = await res.text();
  const frames = [];
  for (const block of text.split('\n\n')) {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    if (event) frames.push({ event, data });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * Each check throws to fail. Grouped roughly by the runtime facility they
 * exercise rather than by endpoint, since that is what a runtime swap breaks.
 */
function buildChecks(ctx) {
  const eq = (actual, expected, what) => {
    if (actual !== expected) {
      throw new Error(`${what}: expected ${expected}, got ${actual}`);
    }
  };

  return [
    ['routing: healthz/readyz/metrics/capabilities', async () => {
      eq((await fetch(`${BASE}/healthz`)).status, 200, 'healthz');
      eq((await fetch(`${BASE}/readyz`)).status, 200, 'readyz');

      const metrics = await fetch(`${BASE}/metrics`);
      eq(metrics.status, 200, 'metrics status');
      const body = await metrics.text();
      // process.cpuUsage/memoryUsage back these; both are shimmed on Bun.
      for (const name of ['heddle_active_runs', 'heddle_max_concurrent_runs']) {
        if (!new RegExp(`^${name} `, 'm').test(body)) {
          throw new Error(`metrics missing ${name}`);
        }
      }

      eq((await fetch(`${BASE}/v1/capabilities`)).status, 200, 'capabilities');
      eq((await fetch(`${BASE}/nope`)).status, 404, 'unknown route');
      eq((await fetch(`${BASE}/v1/runs`)).status, 405, 'GET on /v1/runs');
    }],

    ['run: start -> end, buffered', async () => {
      const res = await post('/v1/runs', {
        flow: simpleFlow(),
        inputs: { query: 'hi' },
      });
      eq(res.status, 200, 'run status');
      const body = await res.json();
      eq(body.flow, 'conformance-simple', 'flow name');
      eq(body.state.query, 'hi', 'state passthrough');
    }],

    ['run: agent node against an OpenAI-compatible endpoint', async () => {
      const res = await post('/v1/runs', {
        flow: ctx.agentFlow,
        inputs: { query: 'hi' },
      });
      eq(res.status, 200, 'agent run status');
      const body = await res.json();
      if (typeof body.state.result !== 'string' || body.state.result.length === 0) {
        throw new Error(`agent produced no result: ${JSON.stringify(body.state)}`);
      }
    }],

    ['sse: framing and event order', async () => {
      const res = await fetch(`${BASE}/v1/runs?stream=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ flow: simpleFlow(), inputs: { query: 'hi' } }),
      });
      eq(res.status, 200, 'stream status');
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/event-stream')) {
        throw new Error(`stream content-type was "${ct}"`);
      }
      const frames = await readSse(res);
      const events = frames.map((f) => f.event);
      eq(events[0], 'flow_start', 'first frame');
      eq(events.at(-1), 'flow_complete', 'last frame');
      if (!events.includes('node_start') || !events.includes('node_complete')) {
        throw new Error(`missing node frames: ${events.join(',')}`);
      }
      // The frames have to be parseable JSON, not merely present.
      JSON.parse(frames.at(-1).data);
    }],

    ['tool: subprocess with piped stdin/stdout', async () => {
      const res = await post('/v1/runs', {
        flow: toolFlow('echo_tool'),
        inputs: {},
        tools: [
          {
            name: 'echo_tool',
            interpreter: 'sh',
            source: 'cat > /dev/null\necho \'{"ok": true, "who": "tool"}\'\n',
          },
        ],
      });
      eq(res.status, 200, 'tool run status');
      const body = await res.json();
      eq(body.state.ok, true, 'tool output');
      eq(body.state.who, 'tool', 'tool output field');
    }],

    ['tool: non-zero exit surfaces as an error', async () => {
      const res = await post('/v1/runs', {
        flow: toolFlow('fail_tool'),
        inputs: {},
        tools: [
          {
            name: 'fail_tool',
            interpreter: 'sh',
            source: 'cat > /dev/null\necho "boom" >&2\nexit 3\n',
          },
        ],
      });
      if (res.status === 200) throw new Error('a failing tool returned 200');
      const body = await res.json();
      if (!/exit code 3/.test(body.error?.message ?? '')) {
        throw new Error(`exit code not reported: ${body.error?.message}`);
      }
    }],

    ['tool: large output crosses the pipe intact', async () => {
      // 1 MiB in one write. Chunk boundaries differ between runtimes, and a
      // reassembly bug shows up here rather than on a short reply.
      const res = await post('/v1/runs', {
        flow: toolFlow('big_tool'),
        inputs: {},
        tools: [
          {
            name: 'big_tool',
            interpreter: 'sh',
            source:
              'cat > /dev/null\n' +
              'printf \'{"blob": "\'\n' +
              // Strip newlines before taking the count, or `yes` contributes
              // one newline per character and the blob comes out half length.
              'yes x | tr -d "\\n" | head -c 1048576\n' +
              'printf \'"}\'\n',
          },
        ],
      });
      eq(res.status, 200, 'large tool status');
      const body = await res.json();
      eq(body.state.blob?.length, 1048576, 'blob length');
    }],

    ['plugin: out-of-process RPC over stdio', async () => {
      const res = await post('/v1/runs', {
        flow: pluginFlow(),
        inputs: { text: 'quiet' },
        plugins: [shoutPlugin()],
      });
      eq(res.status, 200, 'plugin run status');
      const body = await res.json();
      eq(body.state.text, 'QUIET', 'plugin output');
    }],

    ['plugin: validate without executing', async () => {
      const res = await post('/v1/validate', {
        flow: pluginFlow(),
        plugins: [shoutPlugin()],
      });
      eq(res.status, 200, 'validate status');
      eq((await res.json()).valid, true, 'validate result');
    }],

    ['limits: oversized body is refused', async () => {
      const res = await post('/v1/runs', {
        flow: simpleFlow(),
        inputs: { pad: 'x'.repeat(12 * 1024 * 1024) },
      });
      if (res.status !== 413 && res.status !== 400) {
        throw new Error(`oversized body got ${res.status}, expected 413`);
      }
      await res.text();
    }],

    ['abort: client hangup does not wedge the server', async () => {
      const ac = new AbortController();
      const pending = fetch(`${BASE}/v1/runs?stream=true`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          flow: toolFlow('slow_tool'),
          inputs: {},
          tools: [
            {
              name: 'slow_tool',
              interpreter: 'sh',
              source: 'cat > /dev/null\nsleep 10\necho \'{"done": true}\'\n',
            },
          ],
        }),
        signal: ac.signal,
      }).catch(() => {});

      await sleep(400);
      ac.abort();
      await pending;

      // The abandoned run must release its slot, or the next one is refused.
      for (let i = 0; i < 60; i++) {
        const m = await fetch(`${BASE}/metrics`).then((r) => r.text());
        if (/^heddle_active_runs 0$/m.test(m)) {
          const after = await post('/v1/runs', { flow: simpleFlow(), inputs: {} });
          eq(after.status, 200, 'run after abort');
          await after.text();
          return;
        }
        await sleep(100);
      }
      throw new Error('slot never released after client hangup');
    }],
  ];
}

/**
 * SIGTERM drain, checked on its own server.
 *
 * Separate because it ends the process: the sequence under test is that an
 * in-flight run survives the signal while readiness flips and new runs are
 * refused, and that only holds once.
 */
async function checkDrain(runtime, workDir, toolsDir) {
  const proc = startServer(runtime, workDir, toolsDir);
  await waitForHealth();

  const inFlight = fetch(`${BASE}/v1/runs?stream=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      flow: toolFlow('drain_tool'),
      inputs: {},
      tools: [
        {
          name: 'drain_tool',
          interpreter: 'sh',
          source: 'cat > /dev/null\nsleep 3\necho \'{"drained": true}\'\n',
        },
      ],
    }),
  });

  // Wait until the run is genuinely counted, or the drain tests the fast path.
  let counted = false;
  for (let i = 0; i < 100; i++) {
    const m = await fetch(`${BASE}/metrics`).then((r) => r.text()).catch(() => '');
    if (/^heddle_active_runs 1$/m.test(m)) { counted = true; break; }
    await sleep(50);
  }
  if (!counted) {
    await stop(proc);
    throw new Error('run never registered as in flight');
  }

  proc.kill('SIGTERM');
  await sleep(300);

  const ready = await fetch(`${BASE}/readyz`);
  const readyStatus = ready.status;
  await ready.text();

  const refused = await post('/v1/runs', { flow: simpleFlow(), inputs: {} });
  const refusedStatus = refused.status;
  await refused.text();

  const res = await inFlight;
  const frames = await readSse(res);

  const exited = await Promise.race([
    new Promise((r) => proc.once('exit', () => r(true))),
    sleep(20_000).then(() => false),
  ]);

  await stop(proc);

  if (readyStatus !== 503) {
    throw new Error(`/readyz during drain was ${readyStatus}, expected 503`);
  }
  if (refusedStatus !== 503) {
    throw new Error(`new run during drain was ${refusedStatus}, expected 503`);
  }
  if (frames.at(-1)?.event !== 'flow_complete') {
    throw new Error(
      `in-flight run was cut off; last frame was ${frames.at(-1)?.event}`,
    );
  }
  if (!exited) throw new Error('server did not exit after draining');
}

// ---------------------------------------------------------------------------

async function runFor(runtime) {
  const workDir = mkdtempSync(join(tmpdir(), 'heddle-conf-work-'));
  const toolsDir = mkdtempSync(join(tmpdir(), 'heddle-conf-tools-'));

  const results = [];
  const proc = startServer(runtime, workDir, toolsDir);

  try {
    await waitForHealth();
    const ctx = { agentFlow: await agentFlow() };

    for (const [name, fn] of buildChecks(ctx)) {
      try {
        await fn();
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: err.message });
      }
    }
  } finally {
    await stop(proc);
  }

  // Its own server, and only after the shared one is down: same port.
  try {
    await checkDrain(runtime, workDir, toolsDir);
    results.push({ name: 'drain: SIGTERM finishes in-flight runs', ok: true });
  } catch (err) {
    results.push({
      name: 'drain: SIGTERM finishes in-flight runs',
      ok: false,
      error: err.message,
    });
  }

  rmSync(workDir, { recursive: true, force: true });
  rmSync(toolsDir, { recursive: true, force: true });
  return results;
}

const runtimes = values.runtime === 'both' ? ['node', 'bun'] : [values.runtime];
const llm = await startFakeLlm();
let failed = 0;

try {
  for (const rt of runtimes) {
    process.stdout.write(`\n=== ${rt} ===\n`);
    for (const r of await runFor(rt)) {
      process.stdout.write(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n`);
      if (!r.ok) {
        failed++;
        process.stdout.write(`        ${r.error}\n`);
      }
    }
  }
} finally {
  await stop(llm);
}

process.stdout.write(failed === 0 ? '\nall checks passed\n' : `\n${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
