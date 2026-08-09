# Library

Agent bundles worth keeping. Each entry here is a complete agent — a flow, the
tools it calls, the files it reads — that packs into one `.heddle` archive and
runs anywhere heddle is installed.

Browse them at [heddle.run/library](https://heddle.run/library).

| Entry | What it does | Needs |
|---|---|---|
| [local-notetaker](local-notetaker/README.md) | Records this machine's audio, transcribes it locally, and writes up the meeting — no bot joins the call. | A model key, macOS 14.2+, `ffmpeg`, whisper.cpp |
| [coding-agent](coding-agent/README.md) | Works on a codebase with OpenAI Codex CLI's orchestration: plan, shell, apply_patch, verify, repeat. | A model key, `python3`, `bash` |

Every one runs on `gpt-4o-mini` as written, and every one is a text file you can
point at a different provider — see [LLM providers](https://heddle.run/docs/llm-providers).

## Running one

Pack it, then run the archive:

```bash
node library/build.mjs coding-agent
heddle run library/dist/coding-agent.heddle
```

That is two commands because the second one is the point: `coding-agent.heddle`
is a single file carrying the flow, its tools, its plugin and a sample project,
and it runs on a machine that has never seen this repository. Send it to
someone.

Or run the source directly, which is what you want while you are editing it:

```bash
heddle run library/local-notetaker/spec.yaml \
  --tools-dir library/local-notetaker/tools \
  --input '{"minutes":60}'
```

`node library/build.mjs` with no arguments packs every entry into
`library/dist/`, which is what CI runs. Nothing in `dist/` is committed.

Each entry's README has its own commands, including the ones for pointing it at
your own data rather than the sample the bundle ships.

## What an entry is

```
library/<name>/
  bundle.json    what it is, and the flags that pack it
  spec.yaml      the flow
  README.md      what it does, how to run it, what it will not do
  tools/         one executable per tool, if it has any
  <mounts>/      files the bundle carries, if it reads any
```

`bundle.json` is the recipe and the listing in one file. `build.mjs` turns it
into a `heddle bundle` command; the website reads the same file for the entry's
page.

| Field | |
|---|---|
| `name` | Must equal the directory name — it is the URL and every command in the README |
| `title`, `summary` | The card on the website: a short name and one line |
| `blurb` | A paragraph, for the entry's own page |
| `tags` | Free-form, for filtering |
| `model` | The `model_id` the spec asks for, quoted for the listing |
| `flow` | Path to the spec, relative to the entry |
| `toolsDir` | Directory of tool executables, if any |
| `plugins` | Plugin manifests to ship, if any |
| `mounts` | `src[:dest][:ro\|:rw]`, exactly as `--mount` spells it, with `src` relative to the entry |
| `pluginConfig` | `{ "<ComponentType>": { … } }`, resolved at pack time |
| `requires` | What the machine running it must already have, as a list of `{"binary"\|"env"\|"file"\|"node": …, "hint": …}` — checked before a run starts, never installed. See below |
| `input` | The default input recorded in the bundle, so `heddle run <it>.heddle` works with no flags |

## Adding one

1. Copy the closest entry and edit it. `local-notetaker` branches and has
   tools; `coding-agent` carries a plugin and a bundled workspace.
2. Check it, then run it against a stub model — no key, no spend:

   ```bash
   node .claude/skills/create-heddle-agent/driver.mjs check library/<name>/spec.yaml --tools-dir library/<name>/tools
   node .claude/skills/create-heddle-agent/driver.mjs run   library/<name>/spec.yaml --tools-dir library/<name>/tools
   ```

   The [create-heddle-agent skill](../.claude/skills/create-heddle-agent/SKILL.md)
   documents the driver, including how to script an exact conversation to reach
   a particular branch.
3. `node library/build.mjs <name>` must pass. CI packs every entry, so an entry
   that stops packing fails the build rather than shipping a listing for a
   bundle nobody can run.
4. Write the README, and add a row to the table above.

Two rules the entries hold to, because a library people can trust is worth more
than a big one:

- **A tool that fails returns its failure as data and exits 0.** A tool that
  dies takes the run with it; one that answers `{"error": "…"}` lets the agent
  say what went wrong and try something else.
- **Nothing is bundled that should not travel.** No keys, no session state, no
  sandbox policy. A spec names its key as `$OPENAI_API_KEY` and it resolves on
  the machine that runs. See [Bundles](https://heddle.run/docs/bundles).

## What an entry needs, and checking for it

Most entries need nothing but heddle and a key. When one needs more, `requires`
says so, and it says it in a form that is checked rather than only displayed:

```json
"requires": [
  { "binary": "ffmpeg", "hint": "brew install ffmpeg" },
  { "binary": "whisper-cli", "hint": "brew install whisper-cpp" },
  { "env": "OPENAI_API_KEY", "hint": "for the notes step" }
]
```

`heddle doctor library/dist/<name>.heddle` reports everything missing at once
and exits non-zero if anything is, and `heddle run` performs the same check
before it starts. Every predicate only looks — nothing here installs, downloads
or runs anything, and a `hint` is a sentence for a person, never a command. The
older `{ "env": [...], "binaries": [...] }` object still reads, as the same list.

## Running one safely

These bundles come with tools, and a tool is a program that runs on your
machine. `--safe` puts every one of them in an OS sandbox:

```bash
heddle run library/dist/coding-agent.heddle --safe
```

`coding-agent` is built for it — Codex's `workspace-write` sandbox maps onto
`--safe`, and its README describes the posture. `local-notetaker` is the
exception: its recorder reaches the machine's audio devices and builds a helper
binary into `~/.heddle/bin` on first run, which is exactly the reach a tool
sandbox denies — run it unsandboxed and read its tools first.
