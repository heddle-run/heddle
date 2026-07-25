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

`--tools-dir` and `--flows-root` are **server-side configuration only**. A
request that tries to set either is rejected with a 400 rather than silently
ignored, so a caller is never misled about what the server will execute.

Without `--flows-root`, the server accepts inline flows only, and rejects every
`flowPath` request. With it, paths are resolved against the root and confined to
it: traversal (`../`), absolute paths, and symlinks pointing outside the root are
all refused with a 404 that does not reveal whether the target exists.

## Endpoints

### `GET /healthz`

```json
{ "status": "ok", "version": "0.2.0-beta.1" }
```

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

### Request body

Both endpoints take the same flow selector. Provide exactly one of:

| Field | Type | Meaning |
|---|---|---|
| `flow` | object | An Agent Spec flow as JSON. |
| `flow` | string | Flow source text. YAML or JSON — YAML 1.2 is a superset of JSON. |
| `flowPath` | string | Path relative to `--flows-root`. Rejected if no root is configured. |

`POST /v1/runs` additionally accepts `inputs`, a JSON object passed to the
flow's start node.

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
| `500` | Failure while running: a tool exited non-zero, an LLM call failed. |

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
