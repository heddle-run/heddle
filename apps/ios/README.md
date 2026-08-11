# Heddle for iOS

A thin client for a running [`heddle-server`](../../packages/server): save
agents, fire runs, watch the event stream, answer suspensions, and hold
conversations — from a phone.

## Why a server client

The macOS app spawns the `heddle` CLI per run and reads its `--protocol
heddle` frames. iOS has no subprocesses and no Node, so this app speaks the
server's HTTP surface instead — `POST /v1/runs?stream=true` and a hand-rolled
SSE parse over `URLSession` (the browser `EventSource` cannot POST). The
frames on the wire are the same `serializeEvent` shapes either way, which is
why `FrameReducer`, `JSONValue`, `Suspension` and the chat/answer flow are
ports of the macOS app's, transport swapped.

What follows from the transport:

- **Agents are flows, not bundles.** The server accepts a `flowPath` under
  its `--flows-root` or the flow document inline; only the CLI opens
  `.heddle` bundles. An agent saved here is one of those two.
- **Sessions are server-minted.** Chat asks `POST /v1/sessions` for an id on
  the first message; the server's store refuses caller-chosen ids (the CLI's
  accepts them, which is why the macOS app mints its own).
- **A resume repeats the flow.** The server compiles per request, so
  answering a suspension re-sends the flow source with `resume` and the
  `answer` — the HTTP twin of repeating `--plugin` flags on a CLI resume.

## Running it

```sh
# on the machine with heddle installed
heddle-server --host 0.0.0.0 --session-store file --flows-root ~/flows

# here
xcodegen generate
xcodebuild -project Heddle.xcodeproj -scheme Heddle \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
```

Point Settings at the server (`http://127.0.0.1:4319` from the simulator,
the Mac's LAN address from a device) and Check connection. Chat needs
`--session-store file`; server paths need `--flows-root`.

A stock `heddle-server` has **no auth** and trusts every caller — keep it on
loopback or a network you trust. The bearer token field is for servers
behind an authenticating proxy, and rides as an `Authorization` header.

## Layout

- `project.yml` — XcodeGen manifest; `Heddle.xcodeproj` is generated, not
  checked in. (The macOS app is bare SwiftPM; an iOS app bundle needs
  Xcode's build system.)
- `Sources/Heddle/Model` — the server client, SSE parse, frame reducer,
  stores, chat controller.
- `Sources/Heddle/Views` — SwiftUI: agents, runs, transcript, chat,
  settings.
- `Tests/HeddleTests` — reducer and SSE parser, fed strings.

`swift test` does not apply here; run the tests with
`xcodebuild -scheme Heddle test -destination 'platform=iOS Simulator,name=iPhone 17'`.
