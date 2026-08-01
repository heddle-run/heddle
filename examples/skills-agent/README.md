# An agent with skills

A **skill** is a short written procedure for a kind of job — how a CSV gets totalled here,
what an incident note has to say. The agent is not told any of them. It is told they exist,
and how to go and look.

```bash
export OPENAI_API_KEY=sk-...

heddle run examples/skills-agent/spec.yaml \
  --tools-dir examples/skills-agent/tools \
  --plugin examples/skills-agent/plugin.json \
  --safe \
  --input '{"task": "Total these expenses by category.\n\ndate,category,amount\n2026-01-04,travel,412.50\n2026-01-09,software,240.00\n2026-01-11,meals,90.95\n2026-01-18,travel,96.00"}'
```

## The shape

Two tools and a prompt. Skills are not a heddle concept, and that is the point — nothing
here is a feature, it is an arrangement of things that already existed.

- `list_skills` returns every skill's name and its first line: **when it applies**, in one
  sentence. That is what the model carries all the time.
- `read_skill` returns one body. That is what a tool call costs, on a task the model decided
  the skill covers.
- The system prompt in `spec.yaml` says to call `list_skills` first, on every task, and to
  follow a skill exactly if one covers the job.

Paste twenty skills into the system prompt instead and you have not built skills, you have
built a long prompt. The index is cheap and the body is not, so the model pays for what it
uses.

## Where the skills come from

`plugin.json` ships them:

```json
"files": [{ "path": "skills", "dest": "skills" }],
"tools": [
  { "name": "list_skills", "path": "bin/list_skills.py", ... },
  { "name": "read_skill",  "path": "bin/read_skill.py", ... }
]
```

`files` puts `skills/` in the [workspace](https://heddle.run/docs/tools#the-workspace) of
every node before the run starts, read-only. The two tools are programs the plugin ships, so
this plugin has **no entry point and starts no process** — it is two programs and a
directory, and heddle reads all of that off the manifest.

**A plugin is not required.** Put `bin/list_skills.py` and `bin/read_skill.py` in your own
tools directory beside the other three, drop `--plugin`, and pass
`--mount ./skills` instead: the skills land in the same place, the tools resolve the same
way, and nothing about the flow or the prompt changes. `--mount` and `files` write into one
namespace and collide against each other — one is the operator's, the other the plugin's.

The split here is only so both forms can be shown without two copies of the same two
scripts, and so `--tools-dir` and the plugin do not both claim `list_skills`.

## What the run does

Given the expenses above, the model should call `list_skills`, see that `tabular-summary`
covers it, read it, and then follow it rather than adding the column up in its head:

1. `write_file` the rows verbatim to `data.csv`
2. `write_file` a `summarise.py` that reads it with the `csv` module
3. `bash: python3 summarise.py`
4. report only the numbers the script printed

The three tools share one workspace, which is what makes that a procedure rather than three
unrelated calls. The answer should end by naming the skill it followed.

## Files

```
spec.yaml              the flow: start → agent → end, and the prompt that is the contract
plugin.json            files: skills;  tools: list_skills, read_skill
bin/list_skills.py     the index: name + first line, per skill
bin/read_skill.py      one body, by name, refusing a name that climbs out
tools/write_file.py    workspace-relative, refuses a path that climbs out
tools/read_file.py     the same, reading
tools/bash.py          a command in the workspace; peers are on PATH
skills/*.md            first line is the description, the rest is the procedure
```

Adding a skill is adding a file. Nothing else changes — not the prompt, not the tools, not
the flow.
