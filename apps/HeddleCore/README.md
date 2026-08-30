# HeddleCore

The apps' shared core: one Swift package holding the logic every Apple front
end needs, so a new runtime adds a transport and a UI — not another copy of
the protocol layer. The macOS menu bar app and the iOS app both depend on it;
it plays the role for them that [`@heddle-run/core`](../../packages/core)
plays for the CLI and the server.

## Why it exists

The macOS app spawns the `heddle` CLI per run and reads its `--protocol
heddle` frames; the iOS app POSTs to a `heddle-server` and reads the same
frames off SSE. The frames on either wire are the same `serializeEvent`
shapes (`packages/core/src/plugin/encoder.ts`), which is why everything past
the transport used to be a file-for-file port between the two apps. This
package is those files, kept once:

| | |
|---|---|
| `JSONValue` | Arbitrary JSON, as manifests and event frames carry it |
| `RunFrame` / `FrameReducer` | One streamed frame, and the fold from frames to a transcript and final state |
| `TranscriptItem` / `Suspension` | What a transcript renders; what a stopped-for-a-person frame carries |
| `SSEParser` / `SSEEvent` | The server-sent-events parse, fed lines, transport-agnostic |
| `RunAgent` / `RunRecord` | One run of one agent as the UI sees it: status, transcript, final state, the summary and answer-rendering rules |
| `BundleArchive` / `BundleReader` | The `.heddle` reader — gzip (Apple's zlib, via the `CZlib` system-library target) plus a hand-rolled ustar parse porting `packages/core/src/bundle/tar.ts` rule for rule, and the safe extraction of `unpack.ts` |
| `BundleManifest` | The full `heddle.json`, validated as `format.ts` validates it |
| `BundlePortability` | Whether an extracted bundle can run inside an embedded JS engine, with a typed reason for every way it cannot |
| `Requirement` | A `requires` entry as the manifest carries it; each app's preflight observes its own machine |

What deliberately stays out: transports and stores. Spawning processes
(`HeddleCLI`, macOS), HTTP + SSE plumbing (`ServerClient`, iOS), each app's
`Agent` type and its `RunStore` — those differ by design, and each app keeps
its own. `RunRecord` is generic over the app's agent type, which conforms to
`RunAgent` by having a name.

The engine itself is not here and never will be: agent logic lives in
`@heddle-run/core` behind the CLI and the server. This package is the client
half — the shapes those runtimes emit and the folding they imply.

## Using it

Both apps reference the package by relative path. The macOS app declares it
in `apps/macos/Package.swift`; the iOS app in `apps/ios/project.yml` (XcodeGen
resolves it into the generated project). Nothing to install or publish.

## Tests

```bash
cd apps/HeddleCore
swift test
```

Pure logic fed strings — no CLI, no server, no UI. The apps' own suites keep
what is theirs: the macOS CLI round trips, the iOS request encoding.
