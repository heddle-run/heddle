# coding-agent: file operations, shell, planning, and sub-agents

A single `AgentNode` given the toolset of a coding assistant: it can explore a
codebase, edit files, run commands, keep a plan, and delegate specialized work
to sub-agents that are themselves heddle flows.

| File | What it is |
|------|------------|
| `spec.yaml` | The flow: `start → coder → end`, one agent, eight tools |
| `tools/` | The eight tool executables, shell and Python |
| `agents/` | Two sub-agent flows, run by the `delegate_task` tool |

## The tools

| Tool | What it does |
|---|---|
| `read_file` | Read a file's contents |
| `write_file` | Create a file (parent directories included) |
| `edit_file` | Replace an exact string match in an existing file |
| `list_directory` | List entries at a path |
| `search_files` | Glob matching and grep-style content search |
| `execute_command` | Run a shell command; returns stdout, stderr and exit code, 25s timeout |
| `write_plan` | Keep a `.plan.md` of markdown checkboxes in the working directory |
| `delegate_task` | Run a sub-agent flow and return its result |

The system prompt in `spec.yaml` tells the model how to sequence them:
explore first, plan before acting, edit rather than rewrite, verify with
`execute_command`, delegate review and test-writing.

## The agents/ subdirectory

`agents/` holds two more Agent Spec flows, each the same three-node shape as
the main one:

- `code_reviewer.yaml` — reviews code for bugs, security issues and improvements
- `test_writer.yaml` — generates test cases for code

Neither is referenced from `spec.yaml`. The wiring is entirely inside
`tools/delegate_task.sh`: the tool takes an `agent_name` and a `task`, resolves
`agents/<agent_name>.yaml` relative to itself, and runs it as an independent
flow with `npx --package=@heddle/cli heddle run`, passing the task as input and
handing the sub-flow's `result` back as its own tool output.

So "sub-agent" is not a heddle feature — it is a tool that happens to invoke
heddle. The main agent sees `delegate_task` as one more tool; the sub-agent
runs in its own process with its own model loop, and only its final result
returns.

## Run it

With the CLI installed (or spell `heddle` as `npx @heddle/cli`):

```bash
export OPENAI_API_KEY=sk-...

heddle run examples/coding-agent/spec.yaml \
  --tools-dir examples/coding-agent/tools \
  --input '{"task": "list what is in this directory and summarize the project"}'
```

From a source checkout, build first (`pnpm install && pnpm build`) and use
`node packages/cli/dist/heddle.js run …` with the same arguments.

The final state lands on stdout:

```json
{
  "task": "...",
  "result": "The directory contains ..."
}
```

> **Warning:** these tools edit files and execute commands on a model's behalf,
> as the invoking user. A relative path resolves in the run's workspace, but an
> absolute path reaches anything you can. Read the
> [tools warning](../../README.md#tools) in the root README, and consider
> `--safe` — with the caveat that `delegate_task` spawns `npx`, which a
> sandbox without network and `$HOME` access will break. Try the agent on a
> scratch directory first.
