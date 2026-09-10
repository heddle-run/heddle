# release-notes

Writes the release notes for a range of commits by running the scripts your team
already had.

```bash
cd ~/code/your-project
heddle run release-notes --input '{"since":"v1.4.0","until":"HEAD","repo":".","audience":"customers"}'
```

## The actual point

Every agent framework asks you to port your scripts. This one does not, and the
entry exists to show the distance, which is about fifteen lines.

`scripts/` holds three plainly pre-agent programs — flags in, text out, non-zero
on failure, written for a person:

```bash
./scripts/changes_since.sh --since v1.4.0 --repo .
./scripts/changes_since.sh --since v1.4.0 | ./scripts/issue_ids.py --prefix ENG
./scripts/contributors.sh --since v1.4.0
```

They are not touched, not imported, not rewritten. They still work by hand, and
the release engineer who has been running them since 2023 does not have to care
that an agent now runs them too.

`tools/` holds one shim per script. The whole of a shim:

```bash
read -r -d '' -n 1048576 INPUT || true      # the JSON heddle sends on stdin
# … spend it as flags, run the script, print one JSON object
```

When a script fails, its own exit code and its own stderr come back verbatim:

```json
{"commits":"","count":0,"error":"fatal: ambiguous argument 'v9.9.9..HEAD': unknown revision…"}
```

That is deliberate. A friendlier message invented by the shim is the one thing
the person debugging cannot use.

## Wrapping your own

For each script, copy a shim and change three things: the flags it builds, the
script it runs, and the keys it prints. Then declare it in the spec as a
`ServerTool` whose `name` matches the shim's filename without the extension, and
write the `description` for the model rather than for a manual — it is the only
documentation the model gets.

Two things to keep:

- **Give every optional input a `default`.** Without one heddle tells the model
  the input is required, and the model will invent a value for it.
- **Never print anything but the JSON object on stdout.** Diagnostics go to
  stderr. A tool that prints a progress line has printed a parse error.

## What the agent adds

Grouping and judgement, held to two rules that survive contact with a long log:
every line must trace to a commit it was shown, and a commit subject it cannot
interpret goes in an "unclear" list named by its short hash rather than being
guessed at. `audience` decides whether refactors are in or out.

## Running it here

Against this repository, from a source checkout:

```bash
heddle run library/release-notes/spec.yaml \
  --tools-dir library/release-notes/tools \
  --input '{"since":"HEAD~5","until":"HEAD","repo":"'"$PWD"'","audience":"the team"}'
```

`repo` is an ordinary path on the machine, so no mount is needed — a tool runs
as you. Under `--safe` it is confined to the workspace instead, and the
repository has to be mounted: `--mount ~/code/thing:repo:ro`, then
`"repo":"repo"`.

## In CI

The same command, with the range from the tags the job already knows:

```bash
npx @heddle-run/cli run release-notes \
  --input "{\"since\":\"$PREVIOUS_TAG\",\"until\":\"$GITHUB_REF_NAME\",\"repo\":\".\",\"audience\":\"customers\"}" \
  | jq -r .result > NOTES.md
```

Nothing is installed into the project: no dependency, no lockfile entry, and the
scripts the job runs are still the scripts a person runs.
