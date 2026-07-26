/**
 * Node vs Bun on the same heddle-server build.
 *
 * Always run this with Node, whichever runtime is under test: the load
 * generator and the model stub have to be constants, or the comparison is
 * between two whole systems instead of between two runtimes. What varies is
 * exactly one thing -- the argv[0] that executes packages/server/dist.
 *
 * Reports three numbers per runtime, because they are the three that a
 * "scale heddle" decision actually turns on:
 *
 *   startup   time from spawn to the first answered request. Per container,
 *             and on a per-run-container deployment, per run.
 *   rss       resident set of the server and its descendants, idle and at
 *             peak. This is what decides runs-per-box.
 *   latency   per-run wall clock against an instant model, so what is left on
 *             the clock is heddle's own work.
 *
 *   node bench/bench.mjs [--runtime node|bun|both] [--concurrency 32]
 *                        [--requests 400] [--llm-latency 0]
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVER_ENTRY = resolve(ROOT, 'packages/server/dist/heddle-server.js');

const { values } = parseArgs({
  options: {
    runtime: { type: 'string', default: 'both' },
    concurrency: { type: 'string', default: '32' },
    requests: { type: 'string', default: '400' },
    'llm-latency': { type: 'string', default: '0' },
    'server-port': { type: 'string', default: '4401' },
    'llm-port': { type: 'string', default: '4400' },
    json: { type: 'boolean', default: false },
  },
});

const CONCURRENCY = Number(values.concurrency);
const REQUESTS = Number(values.requests);
const SERVER_PORT = Number(values['server-port']);
const LLM_PORT = Number(values['llm-port']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Resident set of a process and everything it spawned
// ---------------------------------------------------------------------------

/**
 * Tool scripts and plugins are subprocesses, so the server's own RSS is not
 * the footprint of a run. Walk the tree and sum it.
 */
async function treeRssKb(rootPid) {
  let total = 0;
  const seen = new Set();
  const queue = [rootPid];

  while (queue.length > 0) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);

    try {
      const status = await readFile(`/proc/${pid}/status`, 'utf-8');
      const m = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (m) total += Number(m[1]);
    } catch {
      continue; // exited between listing and reading
    }

    try {
      const children = await readFile(
        `/proc/${pid}/task/${pid}/children`,
        'utf-8',
      );
      for (const c of children.trim().split(/\s+/)) {
        if (c) queue.push(Number(c));
      }
    } catch {
      // no children, or the task directory is gone
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

function startFakeLlm() {
  const proc = spawn(
    process.execPath,
    [
      resolve(HERE, 'fake-llm.mjs'),
      '--port',
      String(LLM_PORT),
      '--latency',
      values['llm-latency'],
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  return new Promise((res, rej) => {
    proc.stdout.once('data', () => res(proc));
    proc.once('error', rej);
    proc.once('exit', (code) =>
      rej(new Error(`fake-llm exited early with code ${code}`)),
    );
  });
}

async function waitForHealth(port, deadlineMs) {
  const started = performance.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        await res.text();
        return performance.now() - started;
      }
    } catch {
      // not listening yet
    }
    if (performance.now() - started > deadlineMs) {
      throw new Error(`server did not answer /healthz within ${deadlineMs}ms`);
    }
    await sleep(5);
  }
}

function startServer(runtime) {
  const argv = [
    SERVER_ENTRY,
    '--port',
    String(SERVER_PORT),
    '--host',
    '127.0.0.1',
    // Above the load generator's concurrency, so the gate's 429 path is not
    // what is being measured.
    '--max-concurrent',
    String(CONCURRENCY * 2),
    '--timeout',
    '60000',
  ];
  return spawn(runtime, argv, {
    stdio: ['ignore', 'ignore', 'inherit'],
    env: { ...process.env, NODE_ENV: 'production' },
  });
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGKILL');
  await new Promise((r) => proc.once('exit', r));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

const FLOW = JSON.parse(
  await readFile(resolve(HERE, 'flows/agent.json'), 'utf-8'),
);

async function oneRun() {
  const started = performance.now();
  const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/v1/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ flow: FLOW, inputs: { query: 'benchmark' } }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`run failed ${res.status}: ${body.slice(0, 300)}`);
  return performance.now() - started;
}

/** Keep `concurrency` runs in flight until `total` have completed. */
async function drive(total, concurrency) {
  const latencies = [];
  let issued = 0;
  let failures = 0;

  const worker = async () => {
    for (;;) {
      if (issued >= total) return;
      issued++;
      try {
        latencies.push(await oneRun());
      } catch (err) {
        failures++;
        if (failures <= 3) process.stderr.write(`  ! ${err.message}\n`);
      }
    }
  };

  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = performance.now() - started;

  return { latencies, elapsed, failures };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ---------------------------------------------------------------------------
// One runtime, end to end
// ---------------------------------------------------------------------------

async function measure(runtime) {
  const proc = startServer(runtime);

  // Cold start: spawn to first answered request. The interpreter boot and the
  // module graph are both inside this.
  const startup = await waitForHealth(SERVER_PORT, 30_000);

  // Let the process settle before reading idle RSS, so lazy initialization
  // triggered by the health request is not counted as steady state.
  await sleep(500);
  const idleRssKb = await treeRssKb(proc.pid);

  // Warm up: first requests pay for JIT that steady-state requests do not.
  await drive(Math.min(60, REQUESTS), Math.min(8, CONCURRENCY));

  let peakRssKb = idleRssKb;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      peakRssKb = Math.max(peakRssKb, await treeRssKb(proc.pid));
      await sleep(50);
    }
  })();

  const { latencies, elapsed, failures } = await drive(REQUESTS, CONCURRENCY);

  sampling = false;
  await sampler;
  await stop(proc);

  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    runtime,
    startupMs: startup,
    idleRssMb: idleRssKb / 1024,
    peakRssMb: peakRssKb / 1024,
    completed: latencies.length,
    failures,
    throughput: (latencies.length / elapsed) * 1000,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p99: percentile(sorted, 99),
  };
}

// ---------------------------------------------------------------------------

const runtimes =
  values.runtime === 'both' ? ['node', 'bun'] : [values.runtime];

const llm = await startFakeLlm();
const results = [];

try {
  for (const rt of runtimes) {
    process.stderr.write(`\n=== ${rt} ===\n`);
    results.push(await measure(rt));
  }
} finally {
  await stop(llm);
}

if (values.json) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  const f = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '-');
  const rows = [
    ['runtime', 'startup', 'idle rss', 'peak rss', 'runs/s', 'p50', 'p90', 'p99', 'fail'],
    ...results.map((r) => [
      r.runtime,
      `${f(r.startupMs)}ms`,
      `${f(r.idleRssMb)}MB`,
      `${f(r.peakRssMb)}MB`,
      f(r.throughput),
      `${f(r.p50)}ms`,
      `${f(r.p90)}ms`,
      `${f(r.p99)}ms`,
      String(r.failures),
    ]),
  ];
  const widths = rows[0].map((_, i) =>
    Math.max(...rows.map((row) => row[i].length)),
  );
  process.stdout.write('\n');
  for (const row of rows) {
    process.stdout.write(
      row.map((cell, i) => cell.padEnd(widths[i])).join('  ') + '\n',
    );
  }
  process.stdout.write(
    `\nconcurrency=${CONCURRENCY} requests=${REQUESTS} ` +
      `llm-latency=${values['llm-latency']}ms\n`,
  );
}
