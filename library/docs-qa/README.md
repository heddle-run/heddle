# docs-qa

Answers a question from a folder of documents, citing the file and line it took
each fact from.

```
start ──> answerer (Agent + search_docs + read_doc) ──> end
```

Retrieval with nothing to install and no index to build. One tool greps the
mounted documents, the other reads the paragraph around a match, and the agent
cites `file.md:line` for every fact. For a folder of notes, a handbook, or a set
of runbooks — anything a person would have reached for `grep` on — that is the
whole of what a retrieval step needs to be.

## Run it

```bash
node library/build.mjs docs-qa
heddle run library/dist/docs-qa.heddle
```

The bundle carries two sample documents — an invented on-call policy and deploy
process — so it answers with no setup. The facts in them are made up on purpose:
if the agent gets the escalation window right, it read the mount rather than
remembering something.

## Point it at your own documents

A repeatable flag composes with what the bundle carries, so your documents land
beside the samples:

```bash
heddle run library/dist/docs-qa.heddle \
  --mount ./handbook:docs \
  --input '{"question":"what is the expenses limit for travel?"}'
```

To search only yours, run the spec rather than the bundle — then `docs/` is
whatever you mounted:

```bash
heddle run library/docs-qa/spec.yaml \
  --tools-dir library/docs-qa/tools \
  --mount ./handbook:docs \
  --input '{"question":"..."}'
```

`.md`, `.mdx`, `.markdown`, `.txt` and `.rst` are searched, recursively, skipping
dot-directories and anything over 2 MB.

## The tools

| Tool | |
|---|---|
| `search_docs` | Case-insensitive search for a term or regex, returning `path`, `line` and the matching text. A query that is not a valid regex is matched literally, so `C++ (v2)` is a search rather than an error. |
| `read_doc` | A window of one document — `path`, `start`, `lines` — capped at 400 lines and 20 000 characters. Refuses a path that resolves outside `docs/`. |

## What it will not do

The agent is told the documents are the only authority. Where they are silent it
says so and names what it searched for, rather than answering from what the model
already knows — which is the failure this bundle exists to avoid. Where two
documents disagree it quotes both instead of picking.

That behaviour is prompt, not enforcement. A model can still be wrong about
whether it found something; what the design gives you is a citation to check,
which is why every fact is asked for with a file and a line.

## Requires

`OPENAI_API_KEY` and `python3` (standard library only). The tools read `docs/`
inside the workspace and nothing else, so `--safe` needs no extra grants:

```bash
heddle run library/dist/docs-qa.heddle --safe
```
