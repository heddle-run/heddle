# The embedded engine contract

One JavaScript artifact (`heddle-engine.js`, built by
`packages/core/scripts/build-portable.mjs` from `src/portable-host.ts`) and
one Swift host (`HeddleEngine.swift`) meet at this file. The artifact is
evaluated once in a bare JavaScriptCore context; everything it may touch is
listed here, and everything the host may call is too. Change this file first,
then both sides.

## Host installs, before evaluating the artifact

Plain globals:

- `setTimeout(fn, ms) -> id`, `clearTimeout(id)` — real function callbacks,
  opaque ids.
- `console.log/info/warn/error/debug(...)` — to the host's log.
- `crypto.randomUUID() -> string`.

Host bridge functions (all synchronous from JS's point of view; results come
back through the `__engine_*` callbacks the artifact defines):

- `__host_emit(runId, frameLine)` — the artifact reports one run event as one
  JSON line, exactly the CLI's frame shape `{"event": ..., "data": ...}`.
  `FrameReducer.consume(line:)` parses it unchanged.
- `__host_runEnded(runId)` — called exactly once per `run(...)`, after the
  terminal frame.
- `__host_fetchStart(id, request)` — `request` is
  `{url, method, headers: {name: value}, body: string | null}`. Streamed
  response text comes back via the callbacks below. Text only in v1: model
  APIs speak JSON and SSE.
- `__host_fetchAbort(id)`.
- `__host_resolveEnv(name) -> string | null` — the host's secret store
  (Keychain on iOS). The engine resolves `$ENV` refs through this and through
  nothing else; no `process.env` exists.
- `__host_sessionRead(id) -> string | null`, `__host_sessionWrite(id, json)`
  — one JSON blob per session id. Turn semantics live in the artifact; the
  host does dumb I/O.
- `__host_readFile(path) -> string | null`, `__host_writeFile(path, contents)
  -> bool`, `__host_listDir(path) -> [string] | null` — UTF-8, confined by
  the host to the roots it declared (the extracted bundle directory and a
  per-run scratch directory). Paths are **absolute**, always under a declared
  root — the artifact builds them from `bundleDir`/`scratchDir`; a relative
  path is refused. `null` means missing or refused.

## Artifact defines, after evaluation

```ts
globalThis.HeddleEngine = {
  version: string,            // core package version
  protocolVersion: number,    // EVENT_CONTRACT_VERSION

  // Parse only — runs nothing. Returns a JSON string:
  //   { ok: true, name, inputs: [{key, type, title?, required?}] }
  // or { ok: false, error: string }.
  // Only flow facts: `interactive` and `session` are bundle-manifest fields,
  // and the host already read the manifest natively.
  inspect(flowText: string, format: 'yaml' | 'json'): string,

  // Judge whether a plugin entry would evaluate here — runs nothing. The
  // linker half of core's `checkPortability`, offered so a host whose
  // portability check lives in another language never re-implements the
  // linker's rules. pluginJSON decodes to
  //   { entrySource: string, files: { [pluginDirRelativePath]: source } }
  // and the reply is a JSON string: { ok: true } or
  // { ok: false, problems: string[] } — one plain sentence per blocker.
  linkCheck(pluginJSON: string): string,

  // Starts a run and returns immediately; progress arrives via __host_emit,
  // completion via __host_runEnded. configJSON decodes to RunConfig below.
  run(configJSON: string): void,

  // Aborts; the run still emits a terminal frame and __host_runEnded.
  cancel(runId: string): void,
};

// Fetch plumbing the host calls back into:
globalThis.__engine_fetchResponse(id, {status: number, headers: {..}});
globalThis.__engine_fetchChunk(id, textChunk);   // host buffers to UTF-8 boundaries
globalThis.__engine_fetchEnd(id);
globalThis.__engine_fetchError(id, message);
```

`RunConfig`:

```ts
{
  runId: string,                       // host-minted, unique per run
  flow: { text: string, format: 'yaml' | 'json' },
  bundleDir: string,                   // absolute; the extracted bundle
  scratchDir: string,                  // absolute; this run's writable root
  plugins: [{
    manifest: object,                  // the plugin's parsed .json manifest
    entrySource: string,               // the entry's source text
    dir: string,                       // its directory under bundleDir
  }],
  pluginConfig: { [componentType: string]: object },
  inputs: { [key: string]: unknown },
  session: string | null,              // null = one-shot run
  resume: boolean,
  answer?: unknown,                    // only meaningful with resume
  maxToolRounds?: number | string,
}
```

## Frames

Everything the engine emits goes through the builtin encoder, so the frame
vocabulary is the CLI's: `flow_start`, `node_start`, `node_complete`,
`token_delta`, `tool_call`, `tool_result`, `node_error`, `warning`,
`plugin_log`, `plugin:<Type>:<name>`, `flow_complete`. The artifact
synthesizes the two frames no engine event carries:

- `{"event": "suspended", "data": {session, by, seam, ask, node, resume}}`
  when a run suspends — the same synthesis `packages/cli/src/cli/run.ts`
  performs from `RunSuspended`.
- `{"event": "error", "data": {message}}` for a run-level failure.

A run ends with exactly one of `flow_complete`, `suspended`, or `error`,
followed by `__host_runEnded(runId)`.

## Inside the artifact (host does not see, but relies on)

- `AbortController`/`AbortSignal.timeout/.any` are polyfilled by the artifact
  when the context lacks them; host-provided implementations win.
- Plugins load via `servePlugin` from `@heddle-run/core/portable`: the entry
  source is evaluated with the in-process `serve` injected; capability
  grants, event-name rules and error texts match the subprocess runtime by
  construction. An entry that imports its own sibling files is linked first
  (`linkEntry`, the same walk `linkCheck` exposes), the siblings read
  through `__host_readFile` at paths under the plugin's `dir` — which is why
  `dir` sits inside `bundleDir`, a root the host has declared for the run.
- The model provider is the artifact's own, over `__host_fetch*`: an
  OpenAI-compatible chat-completions client (JSON request, SSE stream
  parsing) honoring the flow's `LLMConfig` the way core's builtin provider
  does. Env refs resolve through `__host_resolveEnv` before a request is
  built; an unset name fails the run with the same message the CLI gives.
- Sessions implement core's `SessionStore` over
  `__host_sessionRead/Write`; turn open/close/resume semantics are core's
  (`session/turn.ts`), so a transcript read back matches the server's shape.
