# Examples

Thirteen worked examples, each with a README of its own. They are ordered here as
a learning path: the first rows need nothing but an OpenAI key, the middle
rows introduce plugins, and the last rows are specs authored outside this repo
that heddle validates as-is.

Start with [research-assistant](research-assistant/README.md).

| Example | What it demonstrates | Where it sits |
|---|---|---|
| [research-assistant](research-assistant/README.md) | The smallest complete flow: one agent, two stub tools, input to output. | Start here |
| [bash-agent](bash-agent/README.md) | An agent with a whole shell, `--safe` confinement, and a tool that hands files back out of the workspace. | Beginner |
| [coding-agent](coding-agent/README.md) | A coding assistant: file operations, shell, planning, and sub-agents delegated as independent heddle flows. | Beginner |
| [skills-agent](skills-agent/README.md) | Skills as plain files: a plugin ships a directory of procedures the agent reads on demand — no code, no process. | Intermediate |
| [guardrails](guardrails/README.md) | A custom `Processor` transform plugin used as pre- and post-guardrail on an agent, with rejection routing. | Intermediate |
| [approval-gate](approval-gate/README.md) | Middleware that suspends a run until a person answers, with `--session --resume --answer`. | Intermediate |
| [policies](policies/README.md) | Four middleware — retry, approval, audit, rate limit — and how an operator composes them at the seams of a run. | Advanced |
| [ag-ui](ag-ui/README.md) | An encoder plugin rendering the run as the [AG-UI](https://docs.ag-ui.com) protocol, selected per request with `--protocol` / `?protocol=`. | Advanced |
| [docker-agent](docker-agent/README.md) | An input format plugin reading a [Docker agent file](https://docs.docker.com/ai/docker-agent/configuration/overview/): a different spec translated into Agent Spec at the parse, selected with `--format`. | Advanced |
| [session-store](session-store/README.md) | Replacing where the server keeps conversations with a SQLite-backed `store` plugin. | Advanced |
| [math-homework-agent](math-homework-agent/README.md) | Portability: an Oracle-authored bare `Agent` spec that heddle validates unmodified. | Reference |
| [rag-agent](rag-agent/README.md) | Portability: an Oracle-authored agent whose retrieval is just a `ServerTool` returning an array. | Reference |
| [oracle-it-assistant](oracle-it-assistant/README.md) | Portability at flow scale: Oracle's multi-agent IT-support flow — orchestrator, branching, specialist agents. | Reference |

Every command in these READMEs is written for an installed CLI (`heddle`, or
`npx @heddle-run/cli`), run from the repository root. From a source checkout,
build first (`pnpm install && pnpm build`) and substitute
`node packages/cli/dist/heddle.js` for `heddle`.
