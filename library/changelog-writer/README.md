# changelog-writer

Reads a range of git commits and writes the release notes for them.

```
start ──> changelog (Agent + git_tags + git_log) ──> end
```

Give it a repository and it asks git what the last tag was, reads every commit
since, and writes the notes grouped by what the change does to whoever installs
it — breaking, added, fixed, changed. It reads the repository you name rather
than the directory it starts in, so it works on any checkout on the machine
without being copied into one.

## Run it

```bash
node library/build.mjs changelog-writer
heddle run library/dist/changelog-writer.heddle \
  --input "{\"repo\":\"$PWD\",\"range\":\"since the last release\"}"
```

`repo` is not optional and `.` will not do — see below. `range` is anything git
understands (`v0.1.0..HEAD`, `HEAD~20..HEAD`), or the words
`since the last release`, which makes the agent call `git_tags` and work out the
range itself.

## Why `repo` has to be a path you name

A tool's working directory is a workspace of its own — scratch space heddle
creates for the run and removes afterwards — so `.` means that directory, not
your repository. Both tools check for this and say so:

```
repo '.' resolved to /tmp/heddle-…/, which is this tool's workspace
and not a repository. Pass an absolute path to the repository instead.
```

There is no `$PWD` fallback on purpose. It would work unconfined, where a tool
inherits heddle's environment, and vanish under `--safe`, where the sandbox
clears it — and a tool that works only when unconfined is worse than one that
always asks for the path.

## The tools

| Tool | |
|---|---|
| `git_log` | Commits in a range, newest first, with subject, author, date and a truncated body. Up to 500. |
| `git_tags` | The most recent tags with their dates, newest first. What lets the agent answer "since the last release" without being told what the last release was. |

Both return `{"error": "…"}` rather than dying, so a range that does not exist
is something the agent can report and retry past.

Neither runs `git` through a shell, and a `range` beginning with `-` is refused:
a range is a revision, and a model that guessed `--all` would otherwise be
passing options to git rather than naming commits.

## What it writes

Markdown, under only the headings that have something under them, in this
order: **Breaking changes**, **Added**, **Fixed**, **Changed**. One bullet per
user-visible change, in the present tense, describing the effect rather than the
diff — "sessions survive a restart", not "refactor session store" — with the
short hash in brackets.

Several commits for one change collapse into one bullet. Formatting commits,
test-only commits, lockfile bumps and merge noise are left out. It does not
invent a version number.

## Under `--safe`

The repository is outside the workspace, so it has to be granted:

```bash
heddle run library/dist/changelog-writer.heddle --safe \
  --allow-read "$PWD" \
  --input "{\"repo\":\"$PWD\",\"range\":\"HEAD~20..HEAD\"}"
```

`git` itself must also be on the sandbox's fixed `PATH` — a system install is;
one under `$HOME` is not, because `$HOME` is exactly what the sandbox hides.

## Requires

`OPENAI_API_KEY`, `git`, and `python3` (standard library only).
