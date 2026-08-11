# Heddle for macOS — menu bar app design

Design notes for a native macOS menu bar app that runs heddle agents without
the terminal: an icon in the status bar, a list of agents, one click to run.
A roadmap, not a manual — like the other design documents here.

## What it is

A small native app whose whole surface is the menu bar. Clicking the icon
shows the user's agents; picking one runs it. Runs that need input get a small
panel; runs that want a conversation get a chat window; everything else runs
silently and lands as a notification with the result. The CLI stays the
product for developers — this app is for the person who received a `.heddle`
bundle and should never have to open a terminal.

Goals:

- Run any `.heddle` bundle (or flow file) from the menu bar in one click.
- Show live progress while a run executes, and the result when it finishes.
- Handle the whole lifecycle the CLI handles interactively: missing API keys,
  preflight requirements, sessions, and runs suspended on a human approval.
- Feel native: menu bar extra, notifications, Keychain, Finder integration.

Non-goals (for now):

- Authoring or editing flows — the app runs bundles, it does not make them.
- Anything cross-platform. This is a Mac app; a tray app for Windows/Linux
  would be a separate effort with the same backend seam.
- Replacing the CLI. Both front ends drive the same runtime.

## Why this is cheap to build

The repo already contains the hard half. The CLI is a complete front end over
the engine, and it speaks machine-readable output on request:

- `heddle run <agent> --protocol heddle` emits one JSON frame per line on
  stdout (`frameLine`, `packages/cli/src/cli/encoders.ts`) — the run's whole
  event stream, ending in `flow_complete` with the final state.
- It opens `.heddle` bundles completely — unpacking, bundled tools, plugins,
  mounts, the recorded input (`packages/cli/src/cli/bundles.ts`).
- `--session` / `--resume` / `--answer` and the `heddle sessions` command
  cover conversations and suspended runs, over the on-disk store
  (`~/.heddle/sessions`, `packages/core/src/session/file-store.ts`).

Bundles are self-describing (`packages/core/src/bundle/format.ts`): the
`heddle.json` manifest carries a display `name`, a default `input`, an
`interactive` flag (this bundle would rather open a conversation), a `session`
flag (keep runs in a conversation), and `requires` — preflight declarations
including the env vars it needs. `envRequirements()` in
`packages/core/src/preflight.ts` exists precisely "for a front end that would
rather ask", which is what this app is.

So the app is a thin native shell: discovery, forms, windows, notifications,
Keychain. No agent logic lives in Swift.

## Architecture

```
┌───────────────────────────────┐
│  Heddle.app (SwiftUI)         │
│  MenuBarExtra · run window ·  │
│  chat window · notifications  │
└──────────────┬────────────────┘
               │ spawn per run; JSON frames on stdout
┌──────────────┴────────────────┐
│  heddle run <agent>           │
│    --protocol heddle          │
│  (bundled node + CLI dist)    │
└──────────────┬────────────────┘
               │ existing engine
        @heddle-run/core
```

**Shell: SwiftUI with `MenuBarExtra`.** Native is the right call for a status
bar app — an Electron shell for a menu bar utility is 200 MB of Chromium to
draw a popover, and Tauri would still need Node bundled anyway for the
runtime. Swift needs only `Process` and a line parser; no framework at all.

**Backend: the CLI, one `heddle run` process per run.** *(Revised during M0 —
the first draft chose `heddle-server`, and implementation found the decisive
fact: the server accepts inline `flow` or a confined `flowPath`
(`packages/server/src/flow-source.ts`) and does not open `.heddle` bundles at
all. Unpacking, per-bundle tools, plugins, mounts and recorded input live in
the CLI's `openBundle` path, `packages/cli/src/cli/bundles.ts`. Teaching the
server bundles means per-request plugin loading — a real design question of
its own — while the CLI runs them today.)*

The app ships a Node runtime and the packed CLI in `Resources/`, and each
click spawns `heddle run <agent> --protocol heddle`, which emits one JSON
frame per line on stdout (`frameLine`, `packages/cli/src/cli/encoders.ts`;
frame data is `serializeEvent`, `packages/core/src/plugin/encoder.ts`). The
app folds `node_start` / `token_delta` / `tool_call` / `node_error` /
`flow_complete` frames into the transcript, and reads the final output from
`flow_complete`'s `state` — the same object the CLI prints. Process-per-run
is also the concurrency model: runs are independent processes, cancelling is
`terminate()`, and a crash takes one run rather than an engine.

What the server seam was going to provide, the CLI already has: sessions
(`--session`, `heddle sessions`, the same `~/.heddle/sessions` store),
resume/answer for suspended runs, preflight, env asking. A per-turn process
against an on-disk session makes even the chat window stateless. The
`--auth-token` flag from the first draft landed anyway
(`packages/server/src/auth.ts`) — it hardens any local `heddle-server`, and
keeps the server viable as an alternate backend if the app ever wants
multiplexed runs behind one process.

One note that survives the pivot unchanged: env secrets enter through the
child process environment at spawn (see Secrets below), never over a wire.

**Why not embed the engine directly (JavaScriptCore/node-api)?** The engine
spawns tool subprocesses and plugin processes (`SubprocessExecutor`,
`packages/core/src/sandbox/`); it wants a real Node host. A child process is
also crash-isolated: a plugin that dies takes its run down, not the menu bar.

## UX

### The menu

```
🧵  (status item — animates while a run is live)
├── Changelog Writer
├── CSV Analyst
├── Meeting Notes                ▶ run with defaults
├── ─────────────
├── Running: Zoom Notetaker ⏳    ▶ opens progress popover
├── Needs your answer: Coding Agent ⚠︎
├── ─────────────
├── Recent runs                  ▸ submenu, last 10, click for result
├── Sessions…                    ▶ window listing conversations
├── Add Agent…                   ▶ file picker / paste URL
├── ─────────────
├── Settings…                    (keys, agents folder, login item)
└── Quit Heddle
```

### Running an agent

Click an agent and the app reads its manifest, then takes the shortest path
that respects it:

1. **Missing requirements** (`requires` in the manifest): show the preflight
   panel first — green checks for what is held, a field for each missing env
   var (saved to Keychain), and plain text for missing binaries ("this agent
   needs `ffmpeg`"), which the app reports but never installs — same contract
   as the CLI (`packages/cli/src/cli/install-recipes.ts` notwithstanding;
   recipes stay a CLI affordance).
2. **`interactive: true`**: open a chat window (a regular window, not the
   popover — conversations outlive the click). With `session: true` the
   conversation persists and shows up under Sessions.
3. **Has an `input` with user-facing fields**: small popover form. The common
   case is one `query` string (`DEFAULT_INPUT_KEY` in
   `packages/cli/src/cli/run.ts`) — one text field and a Run button. Defaults
   from the manifest pre-fill the form.
4. **Neither**: run immediately with the recorded input. The icon animates; a
   notification arrives on completion with the tail of the output, click to
   open the full result.

### Live progress

The frame stream renders in the run window: node transitions as a step list,
tool calls with their names, model output streaming into a text area — the
same events `packages/cli/src/cli/progress.ts` renders as terminal lines,
drawn as a list instead.

### Suspended runs (approvals)

When a run stops on a human (`RunSuspended` / `isSuspended`), the menu grows a
"Needs your answer" item and a notification fires with action buttons where
the payload allows it. The answer panel shows what the middleware asked and
posts the resume with the answer — the GUI twin of
`heddle run --resume --answer`.

### Finder and system integration

- **Register for `.heddle`** (exported UTI): double-clicking a bundle in
  Finder opens the run panel. Drag-and-drop onto the menu bar icon does the
  same. This is the killer path for "someone sent me an agent".
- **`heddle://` URL scheme**: `heddle://run?agent=<name>&input=...` so
  Shortcuts, Raycast, and scripts can trigger agents. Shortcuts actions
  (App Intents) can follow once the scheme exists.
- **Launch at login** via `SMAppService`, off by default.

## Agent discovery

Three sources, merged into the menu:

1. **The agents folder**: `~/.heddle/agents/` (created on first launch,
   changeable in Settings), watched with FSEvents. Any `.heddle` bundle
   dropped there appears in the menu, named by its manifest. "Add Agent…"
   copies a picked file or downloads a pasted URL into this folder — the CLI
   already accepts https bundle addresses (`packages/cli/src/cli/bundles.ts`),
   and the app keeps that verbatim.
2. **Recents**: flow files or bundles run via Finder/drag that live elsewhere.
3. **Library (later)**: a curated gallery fed from `library/` builds — browse,
   one-click install into the agents folder.

## Secrets

API keys live in the macOS Keychain, one item per env var name, shared across
agents (two bundles requiring `ANTHROPIC_API_KEY` use the same item). Each
`heddle run` spawn materializes the stored keys into that child's environment
— per-run injection comes free with process-per-run, so a key added in the
panel is live on the very next click. Values are never written to disk
outside the Keychain. The preflight panel is the only UI that asks, and only
for names the manifest declares — mirroring `askForEnvRefs`
(`packages/cli/src/cli/env-prompt.ts`).

## Packaging and distribution

- **Node runtime**: ship the official `node` binary (arm64 + x64 → universal
  lipo, or arm64-only to start) plus the packed `@heddle-run/cli` dist in
  `Resources/`. Expect ~55–90 MB in the app; acceptable for this class of
  app. A Node SEA single-binary is a later size optimization, not a
  dependency.
- **Signing**: Developer ID signed and notarized. The app is **not**
  App-Sandboxed — it exists to run user tools as subprocesses — which rules
  out the Mac App Store but is fine for direct distribution (hardened runtime
  stays on; notarization passes without the sandbox).
- **Channels**: DMG from GitHub Releases; `brew install --cask heddle`
  alongside the existing CLI formula (`Formula/heddle.rb`); Sparkle for
  in-app updates.
- **Repo layout**: `apps/macos/` in this monorepo — a Swift Package (builds
  headless with `swift build`, no Xcode project to maintain) plus
  `make-app.sh`, which wraps the release binary, Info.plist, the packed CLI
  dist and the pinned Node binary into `Heddle.app`. The version ships in
  lockstep with the workspace version so app and engine never drift.

## Milestones

**M0 — spike (prove the seam). ✅ Built.** `apps/macos/` compiles with
`swift build`; `RunStore` spawns `heddle run <agent> --protocol heddle`,
folds the frames, and finishes with the flow's state. Proven by
`CLIRoundtripTests` against the real CLI (a model-free Start→End flow), plus
unit tests on the frame reducer. Exit criterion met at the seam: an agent
runs end-to-end from a menu click with no terminal anywhere.

**M1 — MVP. ✅ Built.** Agents folder (`~/.heddle/agents`, kqueue-watched)
feeding the menu from bundle manifests; the pre-run input form (recorded
`input` pre-filled and editable, bare flows get the CLI's default `query`
field, agents recording nothing run on the click itself); run window with
live transcript; completion notifications; Quit terminates in-flight runs.
Landed alongside: `--auth-token` on heddle-server, and — pulled forward from
M2 — `make-app.sh`, which assembles a self-contained `Heddle.app` (release
binary, LSUIElement Info.plist, `pnpm deploy`'d CLI + node in `Resources/
heddle-runtime/`, ad-hoc signed; ~150 MB, of which ~110 MB is the stock node
binary — the size line item to revisit).

**M2 — batteries. Partially built.** Landed: `.heddle` file association (an
exported `run.heddle.bundle` UTI conforming to `public.data` — deliberately
not an archive UTI, which would invite Archive Utility to claim the
double-click; the app opens the file where it lies, no copy); Settings
(agents folder relocation persisted in defaults, launch-at-login via
`SMAppService` with its refusals surfaced, and the resolved runtime shown);
windows moved from SwiftUI `WindowGroup` to an AppKit presenter, because a
menu bar app's file-open events arrive in the app delegate, where
`openWindow` does not reach. Also landed: the preflight panel + Keychain —
`requires` decodes into the same four observations core makes
(`preflight.ts`), missing keys get a secure field whose value goes to the
Keychain and nowhere else, every spawn injects the held keys into the child
environment, and Run stays disabled while a declared key is missing; missing
binaries/files only warn, in the author's own `hint` words, because the app
installs nothing and the CLI's preflight remains the refusing gate.
Deviation: drop-on-the-menu-bar-icon is deferred — `MenuBarExtra` exposes no
drop target; it would take a custom `NSStatusItem`, and Finder double-click
covers the path meanwhile. Still open: signed/notarized DMG (needs a
Developer ID, an account decision rather than code).

**M3 — conversations. ✅ Built.** Chat window for `interactive` bundles: one
`heddle run --session <id>` spawn per message against an app-minted id (the
store honours caller-chosen ids), the assistant's reply rendered by the
repo's own rule (`answerOf`: `result` when a string, the output otherwise),
conversations surviving window closes through the session on disk.
Suspensions: the `suspended` frame becomes a `.suspended` record status, the
menu grows a "needs your answer" item, a notification fires, and the ask
renders in place — question, quick Approve/Deny for the `{"approved": …}`
shape, a JSON field for every other — resuming on the same record with
`--resume --answer`, transcript appended across the resume. The resume
repeats the original spawn's plugin flags, because the middleware that asked
must be loaded again to consume the answer (`ctx.answered`). Sessions
window over `heddle sessions ls/show/rm`: list, transcript, delete. Proven
end-to-end by `SuspensionRoundtripTests`: a `node`-seam middleware suspends
a model-free Start→Tool→End flow, the answer resumes it, the flow finishes.
Not carried over from the sketch: notification *action buttons* (answering
from the notification itself) — answering lives in the windows; revisit if
reaching for the window proves to be friction.

**M4 — reach. Partially built; the rest is a release decision.** Landed:
the `heddle://` scheme — `heddle://run?agent=<name>[&input=<json>]` runs an
agent already in the menu, with input running immediately and without it
taking the normal click path. A URL is a remote control, not an installer:
it cannot name a path, only an installed agent, so a web page cannot make
the app run whatever it likes. Still open, and gated on accounts rather
than code: Developer ID signing + notarized DMG, Sparkle (wants the signed
appcast infrastructure), the Homebrew cask (wants a released artifact), and
the library gallery. Shortcuts App Intents are gated on a build decision
instead: `Metadata.appintents` is produced by Xcode's build system
(`appintentsmetadataprocessor`), which `swift build` never runs, so intents
compiled into this SPM-built app would be invisible to Shortcuts — dead
code until make-app.sh moves to an `xcodebuild`-driven build. Shortcuts
drives the `heddle://` scheme through its Open URL action meanwhile.

## Open questions

- **Per-run processes trade startup for isolation.** Each click pays a Node
  boot (~300–600 ms before the first frame). Fine for agent runs measured in
  seconds; if chat turns make it felt, the answer is the server backend
  behind the same `RunStore` seam — which is why `--auth-token` exists.
- **Where does run output go?** Notifications truncate; the run window is
  per-session. Recent-run results probably persist as files under
  `~/.heddle/app/runs/` so "Recent runs" survives a relaunch — needs a small
  design pass of its own.
- **CLI coexistence.** App-spawned runs and user-run CLI share
  `~/.heddle/sessions` by design (same store), but two writers are worth a
  test pass before M3.
- **Env inheritance.** Launched from Finder, the app has launchd's
  environment, not the login shell's — so PATH-found tools a bundle's flow
  expects may differ from the terminal. Keychain-injected keys (M2) cover
  secrets; a "the app is not your shell" preflight message may need to cover
  the rest.
