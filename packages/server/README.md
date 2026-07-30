# @heddle/server

HTTP API for the heddle execution engine. Same engine the CLI drives — flows
are parsed, compiled into a graph, and run, with execution observable as a
stream of events.

## ⚠️ There is no authentication

**This service executes arbitrary local executables on behalf of its callers.**
Any client that can reach it can run every executable in the configured tools
directory, with the server process's full environment — including its API keys.
It is a remote-code-execution surface by design, in the same way a shell is.

There is no authentication, no authorization, and no rate limiting. Nothing in
this package checks *who* is calling.

What protects you is the bind address. The server listens on `127.0.0.1` by
default, so only processes on the same host can reach it. **Do not change that
unless you have put something in front of it** — an authenticating reverse
proxy, an SSH tunnel, or a network you fully control. Passing `--host` makes the
server print a warning at startup for exactly this reason.

If you need authentication, terminate it in front of this service.

## Install

```bash
npm install -g @heddle/server
```

## Run

```bash
heddle-server --tools-dir ./tools
```

| Flag | Default | Meaning |
|---|---|---|
| `--host <host>` | `127.0.0.1` | Interface to bind. Anything else warns. |
| `--port <port>` | `4319` | Port to listen on. |
| `--tools-dir <dir>` | none | Executables available to every run. |
| `--flows-root <dir>` | none | Root that `flowPath` requests are confined to. |
| `--max-iterations <n>` | `50` | Maximum node executions per run. |
| `--timeout <ms>` | `300000` | Wall-clock budget for a single run. |
| `--plugin-timeout <ms>` | `30000` | Budget for a single call into a plugin process, not for the run. Clamped to `--timeout`. |
| `--max-concurrent <n>` | `4` | Runs at once. Beyond this, requests get a 429. |
| `--drain-timeout <ms>` | `30000` | On SIGTERM, how long in-flight runs get to finish. |
| `--cors-origin <origin>` | none | Browser origin allowed to call this server. Repeatable. |
| `--allow-request-code` | off | Accept tool scripts and plugin modules in the request. |
| `--allow-net <host>` | Let a submitted spec's `llm_config.url` reach a private host it would otherwise be refused — loopback, link-local and RFC1918 addresses are denied under `--allow-request-code`. Repeatable. | none |
| `--work-dir <dir>` | `$TMPDIR` | Where per-run directories are created. |
| `--llm-default-url <url>` | none | Endpoint the default model credential (`HEDDLE_LLM_DEFAULT_KEY`) belongs to. |
| `--safe` | off | Run tool subprocesses inside an OS sandbox. |
| `--sandbox <backend>` | `auto` | `auto`, `bubblewrap` or `seatbelt`. Requires `--safe`. |
| `--allow-read <path>` | none | Read access for sandboxed tools. Repeatable. |
| `--allow-write <path>` | none | Write access for sandboxed tools. Repeatable. |
| `--allow-env <name>` | none | Environment variable to forward into the sandbox. Repeatable. |
| `--deny-net` | off | Block network access for sandboxed tools. |

| Environment variable | Default | Meaning |
|---|---|---|
| `HEDDLE_LLM_DEFAULT_KEY` | none | Model credential for specs that name none. Only ever used with `--llm-default-url`. |
| `HEDDLE_STREAM` | `1` | Whether model calls stream. Set `0` for an endpoint that serves buffered requests but not `stream: true`, or that bills the two differently. |

Both are environment variables rather than flags: the key would otherwise sit in
`ps` output, and `HEDDLE_STREAM` is a per-deployment fact for a service that
ships as a container image with its argv baked in. An unrecognised value for
`HEDDLE_STREAM` fails startup rather than falling back to the default.

`--tools-dir` and `--flows-root` are **server-side configuration only**. A
request that tries to set either is rejected with a 400 rather than silently
ignored, so a caller is never misled about what the server will execute.

### `--allow-request-code`

Off by default. With it on, `POST /v1/runs` and `POST /v1/validate` accept
`tools` and `plugins` alongside the flow, written to a per-run directory that is
removed when the run ends.

Both kinds run outside this process:

- **Tool scripts** become subprocesses. `--safe` confines them — no `$HOME`, no
  writes outside the run workspace, only the environment `--allow-env` names.
- **Plugins** are `{ name, manifest, source }`. The manifest declares the
  component types as data, so parsing a flow that uses one executes nothing;
  the source runs in its own process holding **none** of the server's
  environment, and is killed when the run ends.

A plugin written against the in-process API — a module default-exporting a
plugin object — is refused here, because loading one would run the caller's
code inside the server.

`--plugin-timeout` bounds a single call into a plugin process, not the run. A
run is entitled to make many, so "did this one call stop responding" is not a
question the run's budget can answer — and while a call is outstanding it is
holding a concurrency slot. A plugin that overruns is killed, because a process
that may still be mid-reply cannot be trusted to keep the channel unambiguous.
Raise it for a plugin that legitimately blocks; it cannot exceed `--timeout`.

A plugin granted `runTool` reaches every tool in the run's registry, which
includes `--tools-dir` — not only the tools the same caller submitted. It can
name any of them, with input of its own choosing, without the flow mentioning
it. That is no wider than what a caller already has (a submitted flow can name
the same tool from a `ToolNode`), but it is worth stating plainly: with
`--allow-request-code` on, `--tools-dir` *is* the set of tools you are offering
your callers.

While this is on, a submitted spec also cannot dereference the environment:
`api_key: $VAR` is refused, since the reference is not restricted to model
credentials and the same spec chooses the URL it would be sent to. Callers put
their own key in the spec.

Together those mean one server can serve many concurrent untrusted runs. It
does not mean the server is safe to expose: it has no authentication, no rate
limiting, and it makes outbound requests to hosts its callers name. See
[DEPLOYMENT.md](./DEPLOYMENT.md).

### CORS

`--cors-origin` is what lets a browser page on another origin read responses.
It constrains browsers and nothing else — curl ignores it — so it widens who can
use the server from a web page and is not what keeps anyone out. Origins are
matched exactly; pass it once per origin, or `*` to allow any.

Without `--flows-root`, the server accepts inline flows only, and rejects every
`flowPath` request. With it, paths are resolved against the root and confined to
it: traversal (`../`), absolute paths, and symlinks pointing outside the root are
all refused with a 404 that does not reveal whether the target exists.

### Shutdown

A run is a long-lived HTTP response, so exiting promptly on SIGTERM cuts it off
mid-flight. Under an orchestrator that is not an edge case — it is every rolling
deploy and every scale-in. So the first SIGTERM or SIGINT starts a *drain*:

1. `/readyz` answers 503 and new runs are refused with 503, while the listener
   stays open so both remain observable to a health check.
2. Runs already streaming keep going.
3. When the last one finishes, the process closes and exits 0.
4. If `--drain-timeout` expires first, what remains is closed anyway.

A second signal skips the wait. Set `--drain-timeout` at or above `--timeout` so
a run near its budget can still finish, and give any supervisor a grace period
longer than `--drain-timeout` so the drain is not itself cut short.

## Endpoints

### `GET /healthz`

Liveness. Stays `200` while draining — a draining process is healthy, and
restarting it would kill the streams the drain exists to protect.

```json
{ "status": "ok", "version": "0.2.0-beta.1" }
```

### `GET /readyz`

Readiness: whether new runs should be routed here. `200` normally, `503` with
`{"status":"draining"}` once shutting down.

It stays `200` at the concurrency ceiling. A server refusing overflow with a 429
is doing exactly what it was configured to do, and reporting it unready would
pull a healthy instance out of rotation under precisely the load that needs it.

### `GET /metrics`

Prometheus text exposition, for scaling on load.

```
heddle_active_runs 3
heddle_max_concurrent_runs 8
heddle_run_saturation 0.375
heddle_runs_accepted_total 128
heddle_runs_rejected_total 4
process_resident_memory_bytes 95485952
process_cpu_seconds_total 41.7
```

`heddle_active_runs` is one per open streaming session, and is the *leading*
signal for autoscaling — it rises the moment a session opens, ahead of the CPU
and memory that session goes on to use.

Unauthenticated, like the rest of the surface. Keep it on an internal listener
or unrouted at the proxy.

### `GET /v1/capabilities`

What this server permits, so a client can adapt rather than discover the limits
through 400s.

```json
{
  "version": "0.2.0-beta.1",
  "allowRequestCode": true,
  "acceptsFlowPath": false,
  "sandbox": "bubblewrap",
  "tools": ["web_search"],
  "limits": { "maxIterations": 25, "timeout": 60000, "maxRequestTools": 10 },
  "runsInFlight": 0,
  "runSaturation": 0
}
```

`runSaturation` is `runsInFlight` over `maxConcurrentRuns`, so a client can back
off before it is refused. It is the same number `/metrics` exposes as
`heddle_run_saturation`, for callers that have no metrics scraper.

Tool *names* are listed because a caller writing a flow needs them. Filesystem
paths are not: where the server keeps its executables is of no use to a caller
and of some use to an attacker.

### `POST /v1/validate`

Parses, compiles, and validates a flow without running it. No tool registry and
no executor are supplied, so validation cannot execute anything.

```bash
curl -sX POST localhost:4319/v1/validate \
  -H 'content-type: application/json' \
  -d '{"flow": {"component_type": "Flow", "name": "demo", "...": "..."}}'
```

```json
{
  "valid": true,
  "flow": "demo",
  "startNode": "start",
  "nodes": [{ "name": "start", "type": "StartNode" }]
}
```

Validation does not require LLM credentials, even for flows containing agent
nodes.

### `POST /v1/runs`

Runs a flow and returns the final state.

```bash
curl -sX POST localhost:4319/v1/runs \
  -H 'content-type: application/json' \
  -d '{"flow": {...}, "inputs": {"query": "hello"}}'
```

```json
{ "flow": "demo", "state": { "query": "hello", "result": "..." } }
```

### `POST /v1/runs?stream=true`

Same request, streamed as [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events).

```
event: flow_start
data: {"type":"flow_start"}

event: node_start
data: {"type":"node_start","nodeName":"agent","nodeType":"AgentNode","state":{...}}

event: tool_call
data: {"type":"tool_call","nodeName":"agent","toolName":"web_search","toolArgs":{...},"toolCallId":"call_1","startedAt":1730000000000}

event: tool_result
data: {"type":"tool_result","nodeName":"agent","toolName":"web_search","toolResult":{...},"duration":812}

event: flow_complete
data: {"type":"flow_complete","state":{"result":"..."}}
```

Frames map one-to-one onto the engine's existing runner events — `flow_start`,
`node_start`, `node_complete`, `node_error`, `tool_call`, `tool_result`,
`flow_complete` — with the event type as the SSE event name. The only changes
are the ones JSON forces: `State` becomes a plain object, and `Error` becomes
`{name, message}`.

One extra frame name, `error`, carries failures that occur after the stream has
opened and therefore cannot be an HTTP status. It is the transport's error
channel, not a second event model.

Two notes on the shape:

- **It is a POST, not a GET.** `EventSource` only issues GETs, but a flow spec
  does not belong in a query string — it is large, and it would end up in
  access logs. Consume it with `fetch` and a `ReadableStream`.
- **Compilation happens before the stream opens.** A malformed flow comes back
  as a real `400`, not as a `200` followed by an error frame. Once SSE headers
  are out, the status is fixed at 200.

### `POST /v1/runs?stream=true&protocol=<name>`

The frames above are heddle's own rendering of the run, and they are one
rendering among however many are loaded. `protocol` selects another.

| Value | What you get |
|---|---|
| omitted | heddle's frames, exactly as documented above |
| `heddle` | the same thing, asked for by name |
| anything else | a rendering supplied by a plugin that declares that protocol |

A protocol nothing renders is a `400` listing what this server can render.
`GET /v1/capabilities` reports the same list in `protocols`, plus
`eventContract` — the version of the event shape an encoder is handed.

Two rules worth knowing:

- **A named protocol needs `stream=true`.** The buffered response is one JSON
  body and carries no events at all, so `?protocol=ag-ui` without a stream is a
  `400` rather than a protocol silently ignored. That holds for `heddle` too:
  naming a protocol is a claim about the response body, and omitting the
  parameter is the way to ask for the buffered form.
- **The response's content type is the encoder's.** A protocol other than
  heddle's own need not be carried over SSE, so the header comes from what the
  encoder declared.

An encoder arrives with the request, as a plugin whose manifest declares
`"kind": "encoder"` — which means `--allow-request-code` is required to use one,
and that a server without it renders `heddle` and nothing else. See
`examples/ag-ui/` for a complete one.

Because a plugin cannot claim the name `heddle`, a client asking for it always
gets the frames documented above.

### Request body

Both endpoints take the same flow selector. Provide exactly one of:

| Field | Type | Meaning |
|---|---|---|
| `flow` | object | An Agent Spec flow as JSON. |
| `flow` | string | Flow source text. YAML or JSON — YAML 1.2 is a superset of JSON. |
| `flowPath` | string | Path relative to `--flows-root`. Rejected if no root is configured. |

`POST /v1/runs` additionally accepts `inputs`, a JSON object passed to the
flow's start node.

With `--allow-request-code`, both endpoints additionally accept:

| Field | Type | Meaning |
|---|---|---|
| `tools` | array | `{ name, source, interpreter? }`. `interpreter` is one of `sh`, `bash`, `python3`, `node`, and generates a shebang when `source` has none. |
| `plugins` | array | `{ name, manifest, source }`. `manifest` declares what the plugin provides, as data, so parsing a flow that uses it executes nothing; `source` is ESM calling `serve()`, and only ever runs in its own process. A bare module default-exporting a plugin object — the in-process shape — is refused, because importing it would run the caller's code inside the server. |

Names must match `[A-Za-z0-9_-]{1,64}` — they become filenames, and nothing that
navigates a path is allowed through. Without the flag, a request carrying either
field is rejected with a 400 rather than having it ignored: a caller whose
plugin was silently dropped would see an unknown-component-type failure with no
way to learn why.

```bash
curl -sX POST localhost:4319/v1/runs \
  -H 'content-type: application/json' \
  -d '{
    "flow": {"...": "..."},
    "inputs": {"text": "hello"},
    "tools": [{"name": "shout", "interpreter": "sh", "source": "read -r i\nprintf \"{}\""}]
  }'
```

### Cancellation

If the client disconnects, the run is aborted: the `AbortSignal` is wired to the
response's `close` event and passed into `Runner.run`, which propagates it to
node executors, tool subprocesses, and in-flight LLM calls.

### Errors

```json
{ "error": { "type": "CompileError", "message": "node \"agent\" has no outgoing edges" } }
```

| Status | When |
|---|---|
| `400` | Malformed request, or a flow that fails to parse, compile, or validate. Also naming a tool this server has no executable for. |
| `404` | Unknown route, or a `flowPath` that does not resolve inside the flows root. |
| `405` | Wrong method for a known route. |
| `413` | Request body over 1 MiB. |
| `429` | Already running `--max-concurrent` runs. |
| `500` | Failure while running: a tool exited non-zero, an LLM call failed. |

Excess runs are refused rather than queued: a caller learns now that the server
is busy instead of holding a connection open for the length of someone else's
run to find out.

## Library use

```ts
import { startServer } from '@heddle/server';

const { port, close } = await startServer({
  host: '127.0.0.1',
  toolsDir: './tools',
});
```

`createServer(options)` returns an unbound `node:http` server if you want to
manage the listener yourself. Importing this package has no side effects.

## Implementation note

Routing is hand-rolled on `node:http`. The surface is four routes, and since
this package is an RCE surface, keeping its production dependency list at
exactly one entry (`@heddle/core`) is worth more than router ergonomics.
