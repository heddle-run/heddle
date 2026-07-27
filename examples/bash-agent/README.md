# bash-agent: one tool, a whole shell

An agent whose only tool is `bash`. It runs a command, gets back stdout, stderr and
an exit code, and decides what to do next. `python3` and `node` are on PATH inside
the sandbox, so when the shell is the wrong instrument the agent can write a script
and run it instead.

| File | What it is |
|------|------------|
| `spec.yaml` | The flow: `start → shell → end`, with one `bash` `ServerTool` on the agent |
| `tools/bash.py` | The tool: resolves interpreters, runs the command, reports the exit code |

## Run it

Run from the repository root against the built CLI (`pnpm build` first — the `pnpm dev`
script runs with its own working directory, so the relative paths below would not
resolve):

```bash
OPENAI_API_KEY=sk-... node packages/cli/dist/heddle.js run examples/bash-agent/spec.yaml --tools-dir examples/bash-agent/tools --safe --input '{"task":"what python and node versions are available here?"}'
```

```json
{
  "task": "what python and node versions are available here?",
  "result": "Python 3.14.2 and Node v22.17.0 are both available on PATH."
}
```

`--chat` opens a session instead, each message becoming the next `task`:

```bash
OPENAI_API_KEY=sk-... node packages/cli/dist/heddle.js run examples/bash-agent/spec.yaml --tools-dir examples/bash-agent/tools --safe --chat
```

> **Without `--safe` this agent is a remote shell on your machine.** Tools inherit
> heddle's full environment — `OPENAI_API_KEY` included — and run as you, with your
> home directory and your credentials in reach. Drop `--safe` only against a
> workspace you would hand to a stranger.

## Python and Node inside the sandbox

A confined tool is handed a fixed PATH — `/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
— rather than the one you have in your terminal. An interpreter installed anywhere
else is invisible even when the sandbox can read it, so `tools/bash.py` prepends these
directories when they exist:

1. everything in `$HEDDLE_RUNTIME_PATH` (colon-separated)
2. `/opt/homebrew/bin` — Homebrew on Apple Silicon
3. `/usr/local/bin` — Homebrew on Intel, manual installs on Linux
4. `/opt/nodejs/bin`, `/opt/python/bin` — tarballs unpacked under `/opt`

PATH is only half of it. The sandbox also has to be able to *read* the binary: `/usr`,
`/bin`, `/opt` and (on macOS) `/Library` are readable by default, and anything else
needs `--allow-read`. Which is what makes version managers the awkward case — nvm,
pyenv and asdf all install under `$HOME`, and the sandbox hides `$HOME` precisely
because that is where `~/.ssh` and `~/.aws` live.

| How you installed it | What it needs |
|---|---|
| System package, Homebrew, `/opt` tarball | nothing |
| nvm, pyenv, asdf, or any `$HOME` install | `--allow-read` on the install root, and its `bin` in `$HEDDLE_RUNTIME_PATH` |

For nvm, that is:

```bash
NODE_BIN="$(dirname "$(command -v node)")"
HEDDLE_RUNTIME_PATH="$NODE_BIN" node packages/cli/dist/heddle.js run examples/bash-agent/spec.yaml --tools-dir examples/bash-agent/tools --safe --allow-read "$(dirname "$NODE_BIN")" --allow-env HEDDLE_RUNTIME_PATH --input '{"task":"run node -v and npm -v"}'
```

`--allow-read` on the version root rather than on `bin` is deliberate: `npm` needs the
`lib/node_modules` beside it, so granting only `bin` gets you a `node` that runs and an
`npm` that does not.

To see what the agent will see, ask it — `'{"task":"run python3 -V, node -v and echo $PATH"}'`
costs one model call and reports the truth about the sandbox it is actually in. Piping
into the tool directly answers a different question, since nothing is confined:

```bash
echo '{"command":"python3 -V; node -v"}' | examples/bash-agent/tools/bash.py
```

## The tool contract

| Input | Type | |
|---|---|---|
| `command` | string | Required. Run through `bash -c`, or `sh` where bash is absent. |
| `working_directory` | string | Defaults to `$HEDDLE_WORKSPACE`, and to heddle's own working directory when unsandboxed. |
| `timeout` | integer | Seconds. Default 25, capped at 25 — heddle kills a tool at 30s, and a reported timeout is more useful to a model than a killed subprocess. |

| Output | Type | |
|---|---|---|
| `stdout` | string | Truncated at 10,000 characters. |
| `stderr` | string | Truncated at 5,000 characters. |
| `exit_code` | integer | The command's status; `124` on timeout, `1` when the tool could not run the command at all. |

A failed command is not a failed tool. `bash.py` always exits 0 and puts the failure in
`exit_code`, because heddle treats a non-zero tool exit as a broken tool and aborts the
round — which would deny the model the error message it needs to correct itself.

## What the agent has to work around

The system prompt in `spec.yaml` spells these out, because each one produces a
confusing failure if the model assumes otherwise:

- **Every call is a fresh shell.** `cd`, `export`, and an activated virtualenv do not
  survive to the next call. Steps that depend on each other belong in one command.
- **stdin is closed.** Anything that waits for a terminal hangs until the timeout.
- **`$HEDDLE_WORKSPACE` is the only writable directory** under `--safe`, and it is
  destroyed when the run ends. The working directory is read-only; everything the
  agent creates and wants to keep has to be copied out by the task itself.
- **25 seconds per command.** Long builds need splitting, or a `nohup` and a later poll.

## What confinement actually buys

With `--safe`, this is what the agent's shell finds:

```
$ echo attempt > /path/to/your/repo/file.txt
/bin/bash: /path/to/your/repo/file.txt: Operation not permitted

$ ls ~/.ssh
ls: /var/folders/.../heddle-scratch-qcDzid/home/.ssh: No such file or directory

$ env | grep -c OPENAI
0
```

The repository is readable but not writable, `$HOME` is a throwaway directory created
for that one command, and heddle's own secrets never entered the environment. Add
`--deny-net` and the shell loses the network too, while heddle's own model calls keep
working — they are made by heddle, not by the confined process.

See the [Safe Mode](../../README.md#safe-mode) section of the root README for the full
policy and its limits.
