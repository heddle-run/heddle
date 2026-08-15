# Heddle for macOS

The menu bar app: an icon in the status bar, your agents in a menu, one click
to run — no terminal. Design notes and roadmap live in
[docs/macos-app-design.md](../../docs/macos-app-design.md).

## What it does today

- Lists every `.heddle` bundle (and bare flow file) in `~/.heddle/agents`,
  named by manifest, rescanning when the folder changes.
- Runs one on click by spawning `heddle run <agent> --protocol heddle`, and
  shows the live transcript — node steps, streamed model output, tool calls —
  in a run window, with the final state as the result.
- Agents whose bundle records an `input` get a pre-run form (defaults
  pre-filled, ⏎ runs); bare flows get a `query` field; agents recording
  nothing run on the click itself. Finished runs notify.
- "Add Agent…" copies a picked bundle into the folder; failed runs surface
  the CLI's own words.
- Double-clicking a `.heddle` anywhere opens its pre-run form — the file
  runs where it lies, nothing is copied. (Registered via the app's exported
  UTI; needs the assembled .app to have been launched once.)
- Settings: relocate the agents folder, launch at login, and see which
  heddle runtime the app resolved.
- Bundles declaring `requires` get a preflight section on the run form:
  green checks for what holds, the author's hints for what doesn't, and a
  secure field per missing API key that saves to the Keychain — injected
  into each run's environment, written nowhere else. Run stays disabled
  until every declared key is held.
- Bundles with `interactive: true` open a chat window — one `heddle run
  --session` per message, so the conversation lives on disk and survives
  the window. Runs a middleware stops for approval show up in the menu
  ("needs your answer"), notify, and render the ask in place with
  Approve/Deny (or a JSON answer); the same run then resumes and finishes.
- Sessions… lists what `heddle sessions` knows — the same store the CLI
  reads — with transcripts and delete.
- A `heddle://` scheme for Shortcuts, Raycast and scripts:
  `open "heddle://run?agent=Meeting%20Notes"` takes the agent's normal
  click path; add `&input=<url-encoded JSON object>` to run immediately
  with that input. Only agents already in the menu can be named.
- Approvals answer from the notification itself when the ask follows the
  `{"approved": …}` convention — Approve/Deny buttons resume the run
  without opening a window; any other reply shape opens the window.
- "Add Agent from URL…" installs a `.heddle` someone sent as a link: the
  archive's manifest is read before it joins the folder, and only http(s)
  addresses naming a bundle are accepted — the CLI's own rule for remote
  paths.

## Make the .app

```bash
apps/macos/make-app.sh          # → apps/macos/build/Heddle.app
```

Self-contained: the Swift release binary, an LSUIElement Info.plist, and a
`heddle-runtime/` of the `pnpm deploy`'d CLI plus this machine's node binary,
ad-hoc signed. The app prefers that packed runtime, so the bundle runs on a
machine with neither Node nor heddle installed.

## Build and run

Requires macOS 14+ and a Swift 6 toolchain (Xcode 16 or its CLT).

```bash
cd apps/macos
swift build
```

Everything past the transport — the frame reducer, run records, `JSONValue`
— comes from [`../HeddleCore`](../HeddleCore), the Swift package this app
shares with the iOS app. SwiftPM resolves the relative path on its own;
there is nothing extra to fetch.

The app finds a heddle runtime in this order:

1. `HEDDLE_APP_CLI` — path to a `heddle.js`, with `HEDDLE_APP_NODE` naming
   the node binary. Development against this checkout:

   ```bash
   pnpm build   # once, at the repo root — makes packages/cli/dist/heddle.js
   HEDDLE_APP_CLI="$PWD/../../packages/cli/dist/heddle.js" \
   HEDDLE_APP_NODE="$(which node)" \
   swift run
   ```

2. `heddle-runtime/` inside the app bundle — what make-app.sh packs (M2).
3. A `heddle` on `PATH` — the Homebrew install.

## Tests

```bash
swift test                      # app units; CLI round trip skips
HEDDLE_APP_CLI=… HEDDLE_APP_NODE=… swift test   # + real CLI round trip
```

The frame reducer's own suite lives with the shared code — run it in
`apps/HeddleCore` with `swift test`.

The round trip runs a model-free Start→End flow through the actual CLI and
asserts the record finishes with the flow's state — the M0 exit criterion,
as a test.
