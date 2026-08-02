# issue-triage

Sorts an issue into bug, feature or question, and drafts the reply that kind
needs.

```
                                     ┌─ bug ──────> end_bug
start ──> classify ──> route (branch)┼─ feature ──> end_feature
                                     └─ question ─> end_question
```

A cheap classifier decides what arrived, a `BranchingNode` routes on its answer,
and three specialists draft the reply — each with a prompt written for one case
instead of one prompt hedging across all three. No tools and no network beyond
the model, so it is also the smallest complete example of branching in the
library.

## Run it

```bash
node library/build.mjs issue-triage
heddle run library/dist/issue-triage.heddle
```

The bundle carries a sample issue. Yours:

```bash
heddle run library/dist/issue-triage.heddle \
  --input '{"title":"...","body":"..."}'
```

## What each branch writes

| Branch | Sections |
|---|---|
| bug | Labels, Missing (what the report does not give), Reply |
| feature | Labels, The underlying need, Reply |
| question | Labels, Answerable, Reply, Docs gap |

Each prompt is also a list of things not to do, and those are the parts worth
keeping if you rewrite them: the bug branch may not guess at a cause or promise
a fix, the feature branch may not commit to building anything, and the question
branch may not invent what the documentation says. A triage draft that
overpromises costs more than no draft.

## How the branch is chosen

The classifier is told to answer with a JSON object and nothing else:

```json
{ "kind": "bug", "why": "one short sentence" }
```

An `AgentNode` writes `result`, plus the keys of its answer when that answer
parses as JSON — so `kind` becomes a key in the run's state. A data flow edge
carries it into the `route` node's `branching_mapping_key`, which is the input
every `BranchingNode` reads, and `mapping` turns it into a branch.

`DEFAULT_BRANCH` catches anything unmapped and sends it to the question branch:
a classifier that returned something unexpected has not established that
anything is broken, and the question reply is the one that does least harm when
the classification was wrong.

Two things that will bite you if you edit the routing:

- A branch named in `mapping` with **no control flow edge leaving on it**
  validates clean and then dies mid-run with `no next node from "route"`. The
  mapping and the edges are two halves of one decision.
- The classifier can only write `kind` if the model's final message really is a
  JSON object. `heddle validate` cannot know that, which is why the spec check
  warns about declared outputs beyond `result`.

## Requires

`OPENAI_API_KEY`. No tools, so nothing runs on your machine but heddle itself.
