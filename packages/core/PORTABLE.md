# The portable entry

`@heddle-run/core/portable` is the engine without the machine: everything a
host needs to run a flow when it cannot start a process or open a file. It is
what the iOS app evaluates inside JavaScriptCore; any embedder in the same
position uses the same entry.

Two artifacts come out of `pnpm build`:

- `dist/portable.js` (+ `.d.ts`) — the importable ESM subpath, for JS hosts
  with a module loader.
- `dist/portable/heddle-engine.js` — a single IIFE built by
  `scripts/build-portable.mjs`, for hosts that evaluate one script in one go.
  When `src/portable-host.ts` exists it is the entry (the engine facade that
  defines `globalThis.HeddleEngine`); until then the bare barrel is bundled so
  the graph is still judged.

## The gate

`build-portable.mjs` bundles for `--platform=neutral`, where no `node:*`
module resolves. **A Node builtin reaching the portable graph is a build
failure**, on purpose — it fails here, in CI, rather than on somebody's
phone. Do not mark builtins external to quiet it; give the module an
injection seam instead, the way these were given theirs:

- `Dependencies.scratchWorkspace` — the engine no longer imports the
  workspace factory; Node hosts inject `createScratchWorkspace`.
- `preflight/parse.ts` vs `preflight/check.ts` — declarations parse anywhere,
  checking stats a machine.
- `workspace/collisions.ts` — destination-collision judgment is string work;
  the mount checks that stat and realpath stayed behind.
- Session ids come from `globalThis.crypto.randomUUID()`, not `node:crypto`.

## What the host provides before evaluating

The artifact assumes these globals exist and work:

| Global | Notes |
| --- | --- |
| `fetch` | Only the model path uses it. A JavaScriptCore host bridges to URLSession; the facade's provider needs plain request/streamed-text responses, not the full WHATWG surface. |
| `setTimeout` / `clearTimeout` | Real callbacks; timer ids are opaque. |
| `crypto.randomUUID` | One function; bridge or polyfill. |
| `console.log/info/warn/error/debug` | Route to the host's log. |
| `AbortController` / `AbortSignal.timeout` / `AbortSignal.any` | The facade ships a polyfill for bare JSC; a host that has them natively wins. |
| `TextEncoder` / `TextDecoder` | Not currently referenced; listed because dependencies may acquire uses. |
| `URL` | Egress checks only; unused on-device today. |

`process` is not assumed. The one engine touch of `process.env`
(`llm/provider.ts` resolving `$ENV` refs) is bypassed on the portable path:
the facade resolves env refs through the host's own secret store before the
provider is built.

## What is deliberately absent

- **Anything that spawns**: `SubprocessExecutor`, `PluginHost`,
  `loadPlugins`, the sandbox. Portable plugins run in-process through
  `servePlugin`, which drives the same dispatch implementation the
  subprocess runtime is generated from — one definition of what `serve`
  means, two transports.
- **Anything that reads a disk**: `loadFlow` (parse the text yourself),
  `FileSessionStore` (implement the 7-method `SessionStore` over your own
  storage), bundle pack/extract (the Swift host extracts the gzipped tar
  natively — see `apps/HeddleCore`), the preflight check half.
- **Workspaces and mounts**: they exist to give subprocesses a directory.
  A bundle that declares mounts is not portable — `checkPortability` is the
  definition of record for that judgment, and `heddle bundle` prints its
  verdict at pack time.

## Bundles on a portable host

The host extracts the archive natively and hands this entry the pieces:
flow text, each plugin's manifest JSON and entry source, `pluginConfig`,
recorded `input`. `validateBundleManifest` and `checkPortability` are
exported so the host judges what it holds with the same rules the CLI and
server use. A plugin entry that imports its own sibling files is linked by
`linkEntry` — a conservative rewrite of static `import`/`export` onto plain
classic-script evaluation — and `checkPortability` runs the same linker to
judge it, so the check and the run cannot disagree. What the linker refuses
(bare specifiers, cycles, shapes it cannot read) makes the bundle
non-portable rather than running wrong.
