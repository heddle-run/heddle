# Library

Agent bundles worth keeping. Each entry here is a complete agent — a flow, the
tools it calls, the files it reads — that packs into one `.heddle` archive and
runs anywhere heddle is installed.

Browse them at [heddle.run/library](https://heddle.run/library).

| Entry | What it does | Needs |
|---|---|---|
| [meeting-notes](meeting-notes/README.md) | Turns a raw transcript into decisions, action items and open questions. | A model key |
| [issue-triage](issue-triage/README.md) | Sorts an issue into bug, feature or question and drafts the reply that kind needs. | A model key |
| [docs-qa](docs-qa/README.md) | Answers questions from a folder of documents, citing the file and line. | A model key, `python3` |
| [csv-analyst](csv-analyst/README.md) | Answers questions about a folder of CSVs by writing SQL against them. | A model key, `python3` |
| [changelog-writer](changelog-writer/README.md) | Reads a range of git commits and writes the release notes for them. | A model key, `git`, `python3` |
| [zoom-notetaker](zoom-notetaker/README.md) | Joins a Zoom meeting from its link, waits out the call, and writes up the notes. | A model key, a [Recall.ai](https://recall.ai) key, `python3` |

Every one runs on `gpt-4o-mini` as written, and every one is a text file you can
point at a different provider — see [LLM providers](https://heddle.run/docs/llm-providers).

## Running one

Pack it, then run the archive:

```bash
node library/build.mjs docs-qa
heddle run library/dist/docs-qa.heddle
```

That is two commands because the second one is the point: `docs-qa.heddle` is a
single file carrying the flow, both tools and the sample documents, and it runs
on a machine that has never seen this repository. Send it to someone.

Or run the source directly, which is what you want while you are editing it:

```bash
heddle run library/docs-qa/spec.yaml \
  --tools-dir library/docs-qa/tools \
  --mount library/docs-qa/docs:docs:ro \
  --input '{"question":"how long before an unacknowledged page escalates?"}'
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
| `requires` | `env` variables and `binaries` the machine running it needs |
| `input` | The default input recorded in the bundle, so `heddle run <it>.heddle` works with no flags |

## Adding one

1. Copy the closest entry and edit it. `meeting-notes` is the smallest,
   `issue-triage` branches, `docs-qa` has tools and a mount.
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

## Running one safely

These bundles come with tools, and a tool is a program that runs on your
machine. `--safe` puts every one of them in an OS sandbox:

```bash
heddle run library/dist/docs-qa.heddle --safe
```

`docs-qa`, `csv-analyst`, `meeting-notes` and `issue-triage` read nothing outside
the workspace the bundle mounted into, which is what `--safe` leaves reachable.
`changelog-writer` is the exception: it reads a repository elsewhere on the
machine, so under `--safe` it also needs `--allow-read` for that path. Its README
says so.
