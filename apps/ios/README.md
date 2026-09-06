# Heddle for iOS

Save agents, fire runs, watch the event stream, answer suspensions, hold
conversations, and run agents from Shortcuts — from a phone. A portable
`.heddle` bundle runs on the device itself; everything else runs on a
[`heddle-server`](../../packages/server).

## Two ways to run

The macOS app spawns the `heddle` CLI per run and reads its `--protocol
heddle` frames. iOS has no subprocesses and no Node, so this app runs a flow
one of two ways, and the choice is made per agent:

- **On the device**, for an imported `.heddle` bundle that
  [`checkPortability`](../HeddleCore) clears — everything it ships is data
  plus JavaScript. `HeddleEngine` hosts it in JavaScriptCore, resolving env
  from the Keychain, sessions from blobs on disk, fetches over `URLSession`.
  No server, no network beyond what the flow itself asks for.
- **On a server**, for a flow named by `flowPath` under `--flows-root`, one
  pasted inline, or a bundle too capable to run here — that last one uploads
  to `POST /v1/bundles` once and runs by id thereafter.

The frames are the same `serializeEvent` shapes down either path, which is
why everything past the transport — `FrameReducer`, `JSONValue`,
`Suspension`, `RunRecord`, the SSE parse, the bundle reader, the engine — is
[`HeddleCore`](../HeddleCore), the Swift package both apps share, and why
`RunDetailView` cannot tell you which side ran the flow. What this app adds
is the transports and the screens.

What follows from the server transport:

- **Sessions are server-minted.** Chat asks `POST /v1/sessions` for an id on
  the first message; the server's store refuses caller-chosen ids (the CLI's
  accepts them, which is why the macOS app mints its own). A portable
  bundle's sessions are this phone's, so those ids are minted here.
- **A resume repeats the flow.** The server compiles per request, so
  answering a suspension re-sends the flow source with `resume` and the
  `answer` — the HTTP twin of repeating `--plugin` flags on a CLI resume.

## Shortcuts

**Run Agent** is an App Intent: pick a saved agent, optionally give it a
string, get its answer back for the next action to use. It performs in the
app's own process with no window, on the same `RunStore` the screens drive —
so a shortcut's run takes the same on-device-or-server branch, and lands in
the Runs tab where it can be read back.

Two things fall out of running with nobody watching:

- **Secrets are `kSecAttrAccessibleAfterFirstUnlock`.** An automation fires
  at a locked screen, and the Keychain default (`WhenUnlocked`) would fail
  the read and kill the run at env resolution.
- **An agent that asks a question cannot run here.** A suspension has nobody
  to answer it, so the intent fails with the question it stopped on — those
  agents want the app.

## Running it

```sh
# on the machine with heddle installed
heddle-server --host 0.0.0.0 --session-store file --flows-root ~/flows

# here
xcodegen generate
xcodebuild -project Heddle.xcodeproj -scheme Heddle \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

A server is only needed for the flows that use one. To run a bundle on the
device, hand the app a `.heddle` file — AirDrop, Files, Mail — and fill in
whatever env keys it declares under Settings › API keys.

For the server paths, point Settings at it (`http://127.0.0.1:4319` from the
simulator, the Mac's LAN address from a device) and Check connection. Chat
needs `--session-store file`; server paths need `--flows-root`.

A stock `heddle-server` has **no auth** and trusts every caller — keep it on
loopback or a network you trust. The bearer token field is for servers
behind an authenticating proxy, and rides as an `Authorization` header.

## Layout

- `project.yml` — XcodeGen manifest; `Heddle.xcodeproj` is generated, not
  checked in. (The macOS app is bare SwiftPM; an iOS app bundle needs
  Xcode's build system.) It references [`../HeddleCore`](../HeddleCore) —
  the shared package — by relative path.
- `Sources/Heddle/Model` — the server client, the embedded engine and its
  run assembly, the stores, the chat controller.
- `Sources/Heddle/Intents` — the Shortcuts surface: the Run Agent intent,
  the agent entity and its query.
- `Sources/Heddle/Views` — SwiftUI: agents, runs, transcript, chat,
  settings.
- `Tests/HeddleTests` — the request and capability shapes only this app
  encodes. The reducer and SSE parser suites live with the shared code —
  run them in `apps/HeddleCore` with `swift test`.

`swift test` does not apply here; run the tests with
`xcodebuild -scheme Heddle test -destination 'platform=iOS Simulator,name=iPhone 17'`.
