# bench

Two harnesses for evaluating a runtime or an engine change, and the record of
what they said about Bun.

Both are driven by Node whichever runtime is under test, and both talk to the
server over HTTP rather than importing it. What varies between two measurements
is exactly one thing: the interpreter that executes
`packages/server/dist/heddle-server.js`.

```bash
pnpm --filter @heddle/core build && pnpm --filter @heddle/server build

pnpm bench             # node vs bun, throughput and footprint
pnpm bench:conformance  # node vs bun, does it still behave the same
```

## Why the model is faked

`fake-llm.mjs` is an OpenAI-compatible endpoint that answers instantly. A real
model call is 500ms–20s of network latency, which is 99%+ of a real run and
would bury every difference these harnesses exist to detect. Removing it leaves
heddle's own work on the clock: compile, traverse, serialize, spawn.

That makes these numbers a measurement of the engine, **not** a prediction of
end-user latency. A change that doubles throughput here moves a real
model-bound run by a fraction of a percent. That is the point — it is the
ceiling on what any runtime or engine work can buy, and it is worth knowing
before spending months on one.

## Results: Node 22.22 vs Bun 1.3.11

Same build, same stub, 400 runs at concurrency 32, 4 repetitions. Means:

| | Node 22.22 | Bun 1.3.11 | |
|---|---|---|---|
| cold start to first answered request | 222ms | 130ms | **-42%** |
| idle RSS (process tree) | 84.4MB | 70.0MB | **-17%** |
| peak RSS under load | 154.2MB | 137.2MB | **-11%** |
| throughput | 494 runs/s | 662 runs/s | **+34%** |
| p50 latency | 50.3ms | 43.5ms | -14% |
| p99 latency | 432ms | 95.8ms | **-78%** |

Bun is faster and leaner on every axis, and the p99 gap is the largest single
difference. Run-to-run variance was low; Node's p99 sat between 423 and 456ms
across all four repetitions, which looks more like a recurring stall than
noise. It has not been attributed to a cause — GC and the OpenAI SDK's socket
pool are both untested hypotheses.

## Why Bun is not the default anyway

`conformance.mjs` runs 12 black-box checks against the built server. Bun passes
11. The one it fails is not cosmetic:

> **Bun's `node:http` gives a server no way to learn that the client hung up.**

`runs.ts` wires run cancellation to `res.on('close')`, and aborts the run when
the caller goes away. On Bun that event never fires. Nor does anything else:
after a hangup, `res.destroyed` is `undefined`, `socket.destroyed` is `false`,
`socket.writable` stays `true`, `res.write()` keeps returning `true`, and no
`error`, `aborted`, or socket `end` event is emitted. `req.on('close')` does
fire — but it fires on every well-behaved request too, as soon as the body has
been read, so it cannot distinguish a hangup from a normal run.

Measured consequence, with a run holding a slot and the client disconnecting:

| | slot released after hangup |
|---|---|
| Node | 7ms |
| Bun | 6041ms — the run's full `--timeout`, not the hangup |

An abandoned run keeps its concurrency slot, its tool subprocesses and its
model calls alive until its own timeout expires. Under the playground's
`--timeout 60000 --max-concurrent 8`, eight closed browser tabs take an
instance out of service for a minute and everyone else gets a 429. A
browser-driven deployment is the worst case for this, and it is the deployment
the performance work was for.

So the trade is +34% throughput and -17% memory against a cancellation path
that silently stops working. Not worth it yet.

### What would change the answer

- Bun emitting `close` on `ServerResponse`, or exposing any disconnect signal
  through `node:http`. Re-run `pnpm bench:conformance` on a new Bun and see.
- Serving on `Bun.serve` under Bun, whose `Request.signal` does abort on
  hangup, behind an adapter over the handful of places that touch
  `IncomingMessage`/`ServerResponse` (`http.ts`, `sse.ts`, `runs.ts`,
  `server.ts`). That buys the performance at the cost of a second HTTP
  implementation in a package that is deliberately one code path with one
  production dependency — a real cost to weigh, not a formality.

Nothing here argues against Bun for the CLI, which has no hangup to detect.
That was not measured.

## Do not run vitest under Bun

`bun --bun vitest run` in `packages/core` collects 2 of 13 test files, reports
no error, and exits 0. Node collects all 13 and runs 92 tests. A green run that
skipped 85% of the suite is worse than a red one, so the test runner stays on
Node regardless of what the server is deployed on.

## Files

| | |
|---|---|
| `bench.mjs` | throughput, latency percentiles, cold start, RSS of the process tree |
| `conformance.mjs` | 12 black-box behaviour checks: routing, SSE framing, tool subprocesses, large tool output, out-of-process plugins, body limits, client hangup, SIGTERM drain |
| `fake-llm.mjs` | instant OpenAI-compatible stub, `--latency` to model a slow model |
| `flows/agent.json` | start → agent → end, pointed at the stub |

Both accept `--runtime node|bun|both`. `conformance.mjs` exits non-zero on any
failed check, so it can gate a runtime change in CI.
