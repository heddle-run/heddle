import type { Reference } from "./types";

/* Every spec here has been checked with `heddle validate` — the two that name
   a component type a plugin supplies, under the same --plugin flag their run
   line already carries, because without it the type is genuinely unknown and
   the check is supposed to say so.

   The guardrail and routing flows have also been run end to end. Neither needs
   a credential: a pre-transform that rejects skips the model call, and routing
   has no model in it at all. */

const RESEARCH_FLOW = `weave: 1
name: research-assistant

inputs:
  question: string

# Declaring a tool's inputs is what gives the model a shape to fill in:
# they become the function's parameters.
tools:
  web_search:
    description: Search the web for information
    inputs:
      query: string
    outputs:
      results: string

  calculator:
    description: Evaluate a mathematical expression
    inputs:
      expression: string
    outputs:
      result: string

agent:
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY

  prompt: |
    You are a research assistant. Answer the question. Use web_search when
    you need current information, and calculator for arithmetic.

    The question: {{inputs.question}}

  tools: [web_search, calculator]
`;

const WEB_SEARCH = `#!/usr/bin/env python3
import json, sys

args = json.load(sys.stdin)
query = args.get("query", "")

json.dump({"results": f"Search results for: {query}"}, sys.stdout)
`;

const CALCULATOR = `#!/usr/bin/env python3
import json, sys

args = json.load(sys.stdin)
expression = args.get("expression", "0")

# The model picks this string, so a bare eval() would be
# arbitrary code execution. No letters, no imports.
if set(expression) - set("0123456789.+-*/() "):
    result = "unsupported expression"
else:
    result = str(eval(expression))

json.dump({"result": result}, sys.stdout)
`;

const GUARDRAIL_FLOW = `weave: 1
name: guarded-assistant

inputs:
  query: string

agent:
  # Never reached while the guardrail rejects. That is the point: a
  # blocked prompt costs nothing.
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY

  prompt: |
    You are a concise, helpful assistant. Answer the question:

    {{inputs.query}}

  # Transforms travel with the agent, not with the graph, so this
  # guardrail applies in chat mode and to a standalone agent too. The
  # keys beside "use" are the transform's own config.
  transforms:
    - use: Blocklist
      phase: pre
      patterns:
        - password
        - credit card
      reason: that topic is blocked
`;

const GUARDRAIL_PLUGIN = `export default {
  name: 'heddle-plugin-guardrail',
  version: '1.0.0',

  transforms: [
    {
      // Blocklist is not a heddle type. This adds it.
      componentType: 'Blocklist',
      phase: (node) => node.phase ?? 'pre',

      createTransform(node) {
        // The keys the document wrote beside "use" arrive spread onto
        // the component itself.
        const { patterns = [], reason } = node;

        return {
          apply(messages) {
            const content = String(messages.at(-1)?.content ?? '');

            for (const pattern of patterns) {
              if (new RegExp(pattern, 'i').test(content)) {
                return { action: 'reject', reason };
              }
            }
            return { action: 'pass' };
          },
        };
      },
    },
  ],
};
`;

const ROUTING_FLOW = `weave: 1
name: triage

inputs:
  message: string

tools:
  classify:
    description: Labels the message urgent or normal
    inputs:
      message: string
    outputs:
      label: string

  page_oncall:
    description: Pages whoever is on call
    outputs:
      action: string

  file_ticket:
    description: Files an ordinary ticket
    outputs:
      action: string

steps:
  - name: classify
    tool: classify
    with:
      message: '{{inputs.message}}'

  # Routes on the label the tool wrote. "else" says where every unmatched
  # value goes — there is no implicit default.
  - name: route
    switch: '{{classify.label}}'
    cases:
      urgent: page
    else: file

  - name: page
    tool: page_oncall
    then: paged

  - name: file
    tool: file_ticket
    then: filed

outcomes:
  paged:
    action: '{{page.action}}'
  filed:
    action: '{{file.action}}'
`;

const CLASSIFY = `#!/usr/bin/env bash
read -r input

if printf '%s' "$input" | grep -qiE 'fire|outage|down|urgent'; then
  printf '{"label":"urgent"}'
else
  printf '{"label":"normal"}'
fi
`;

const PAGE_ONCALL = `#!/usr/bin/env bash
read -r input
printf '{"action":"paged the on-call engineer"}'
`;

const FILE_TICKET = `#!/usr/bin/env bash
read -r input
printf '{"action":"filed a ticket for the morning"}'
`;

const AGENT_FLOW = `weave: 1
name: ask

inputs:
  query: string

# A document with a top-level agent and no steps is a one-step flow.
agent:
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY

  prompt: |
    Answer in one sentence.

    {{inputs.query}}
`;

const SHELL_FLOW = `weave: 1
name: shell

inputs:
  task: string

tools:
  bash:
    description: >-
      Run a shell command and return its stdout, stderr and exit code.
      Each call is a fresh shell and commands are killed after 20 seconds.
    inputs:
      command: string
    outputs:
      stdout: string
      stderr: string
      exit_code: integer

agent:
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY

  prompt: |
    You run shell commands to answer the task. python3 and node are both
    on PATH. Each call is a fresh shell, so chain what depends on itself
    into a single command. Read exit_code every time. Answer in one or
    two sentences.

    The task: {{inputs.task}}

  tools: [bash]
`;

const BASH = `#!/usr/bin/env python3
import json, subprocess, sys

args = json.load(sys.stdin)

# --safe --sandbox bubblewrap is what confines this, and it is a flag on the
# run rather than a line in this file. The tool stays the same whether or not
# it is sandboxed; only the run decides.
done = subprocess.run(
    args.get("command", ""), shell=True,
    capture_output=True, text=True, timeout=20,
)

json.dump(
    {
        "stdout": done.stdout,
        "stderr": done.stderr,
        "exit_code": done.returncode,
    },
    sys.stdout,
)
`;

const SKILLS_FLOW = `weave: 1
name: skills

inputs:
  task: string

tools:
  list_skills:
    description: Every skill's name and its one-line description
    outputs:
      skills: string

  read_skill:
    description: One skill's body, by name
    inputs:
      name: string
    outputs:
      body: string

agent:
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY

  # The contract, and the only place it is stated. A model that is not
  # told to look will not look, and a skill nobody reads is a file.
  prompt: |
    You have skills: short written procedures. Their text is not in this
    prompt. list_skills returns every skill's name and description;
    read_skill returns one body. Call list_skills first, on every task.
    If a description covers the task, read that skill and follow it
    exactly -- it outranks how you would otherwise do the job. Finish by
    naming the skill you followed.

    The task: {{inputs.task}}

  tools: [list_skills, read_skill]
`;

const LIST_SKILLS = `#!/usr/bin/env python3
import json, os, pathlib, sys

json.load(sys.stdin)

# The workspace, not the working directory. --mount put the skills here before
# the run started, and $HEDDLE_WORKSPACE is where every tool in this run works.
root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"

index = "\\n".join(
    "%s: %s" % (path.stem, path.read_text().splitlines()[0])
    for path in sorted(root.glob("*.md"))
)

json.dump({"skills": index}, sys.stdout)
`;

const READ_SKILL = `#!/usr/bin/env python3
import json, os, pathlib, sys

args = json.load(sys.stdin)
root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"
path = root / ("%s.md" % str(args.get("name", "")).strip().lower())

# A message rather than a crash: the model picked this name and can pick
# another once it is told.
inside = path.parent.resolve() == root.resolve()
body = path.read_text() if inside and path.is_file() else "no skill by that name"

json.dump({"body": body}, sys.stdout)
`;

const TIDY_SKILL = `Tidying a CSV of numbers

Round every value to two decimals, keep the header row, and write the
result beside the original with a .tidy.csv suffix. Never edit in place:
the original is what someone will check the result against.
`;

const TOOL_AND_PLUGIN_FLOW = `weave: 1
name: shout

inputs:
  text: string

# A tool: an executable the engine runs as a subprocess.
tools:
  shout:
    description: Uppercases the text it is given
    inputs:
      text: string
    outputs:
      shouted: string

steps:
  - name: shout
    tool: shout
    with:
      text: '{{inputs.text}}'

  # A plugin step. ReverseNode is not a heddle type -- the plugin adds it,
  # and it runs in the plugin's own process rather than the engine's.
  - name: reverse
    use: ReverseNode
    with:
      shouted: '{{shout.shouted}}'

outcomes:
  done:
    reversed: '{{reverse.reversed}}'
`;

const SHOUT = `#!/bin/sh
read -r input

text=$(printf '%s' "$input" | sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

printf '{"shouted":"%s"}' "$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]')"
`;

const REVERSE_PLUGIN = `export default {
  name: 'heddle-plugin-reverse',
  version: '1.0.0',

  nodes: [
    {
      // ReverseNode is not a heddle type. This adds it.
      componentType: 'ReverseNode',

      // Declaring the outputs is what lets a document's {{reverse.reversed}}
      // reference validate before anything runs.
      inferOutputs: () => [{ title: 'reversed', type: 'string' }],

      createExecutor: () => ({
        execute(input, ctx) {
          const text = String(input.shouted ?? '');

          ctx.log('info', 'reversing ' + text.length + ' characters');

          return { output: { reversed: [...text].reverse().join('') } };
        },
      }),
    },
  ],
};
`;

const AG_UI_FLOW = `weave: 1
name: rendered

inputs:
  question: string

tools:
  digest:
    description: The SHA-256 of a string, as hexadecimal
    inputs:
      text: string
    outputs:
      sha256: string

# Nothing in this flow knows it is being rendered. Each step's start and
# finish become STEP_STARTED and STEP_FINISHED, its outputs become a
# STATE_SNAPSHOT, the tool call becomes TOOL_CALL_START, _ARGS and _END, and
# the answer arrives as TEXT_MESSAGE_CONTENT deltas.
agent:
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY

  prompt: |
    Call digest for a hash rather than guessing one. Answer in one
    sentence.

    The question: {{inputs.question}}

  tools: [digest]
`;

const DIGEST = `#!/usr/bin/env python3
import hashlib, json, sys

args = json.load(sys.stdin)
text = args.get("text", "")

json.dump({"sha256": hashlib.sha256(text.encode()).hexdigest()}, sys.stdout)
`;

const ENCODER_MANIFEST = `{
  "name": "heddle-plugin-ag-ui",
  "version": "1.0.0",
  "components": [{ "componentType": "AgUiEncoder", "kind": "encoder" }]
}
`;

const ENCODER = `// An encoder renders a run for whoever asked for it and cannot alter it, so
// unlike a middleware it is safe to submit with the request.
export default {
  name: 'heddle-plugin-ag-ui',
  version: '1.0.0',

  encoders: [
    {
      componentType: 'AgUiEncoder',
      protocol: 'ag-ui',

      encode(event) {
        switch (event.type) {
          case 'node_start':
            return { type: 'STEP_STARTED', stepName: event.nodeName };
          case 'node_finish':
            return { type: 'STEP_FINISHED', stepName: event.nodeName };
          case 'token_delta':
            return { type: 'TEXT_MESSAGE_CONTENT', delta: event.delta };
          case 'tool_call':
            return { type: 'TOOL_CALL_START', toolCallName: event.toolName };
          case 'tool_result':
            return { type: 'TOOL_CALL_END', toolCallId: event.toolCallId };
          default:
            // Anything with no AG-UI spelling is dropped rather than
            // invented: a frame a client cannot read is worse than none.
            return null;
        }
      },
    },
  ],
};
`;

export const heddle: Reference = {
  id: "heddle",
  name: "heddle",
  install: "npm install -g @heddle-run/cli",
  packages: [],
  artifact: "a document",
  modelSwap: "Change the model line, or point provider at another backend.",
  docs: "/docs",
  note:
    "The flow is data, not code. heddle parses it and validates the whole " +
    "document — every reference, every target, every tool shape — before " +
    "anything starts, then runs it. Nothing enters your dependency tree, " +
    "and a document that validates is a document that runs.",

  impls: {
    research: {
      files: [
        { name: "flow.yaml", language: "yaml", source: RESEARCH_FLOW },
        {
          name: "tools/web_search.py",
          language: "python",
          source: WEB_SEARCH,
        },
        {
          name: "tools/calculator.py",
          language: "python",
          source: CALCULATOR,
        },
      ],
      run:
        "heddle run flow.yaml --tools-dir ./tools \\\n" +
        `  --input '{"question": "How tall is the Eiffel Tower in feet?"}'`,
      note:
        "A tool is an executable that reads JSON on stdin and writes JSON on " +
        "stdout, so it can be written in any language. The spec declares its " +
        "shape; the file supplies the behaviour.",
    },

    guardrail: {
      files: [
        { name: "flow.yaml", language: "yaml", source: GUARDRAIL_FLOW },
        {
          name: "guardrail.js",
          language: "javascript",
          source: GUARDRAIL_PLUGIN,
        },
      ],
      run:
        "heddle run flow.yaml --plugin ./guardrail.js \\\n" +
        `  --input '{"query": "what is my password"}'`,
      note:
        "Weave defines the slot, an agent's transforms, so the guardrail " +
        "is configuration. A plugin supplies the one component type " +
        "heddle does not ship, and the patterns stay in the document.",
    },

    routing: {
      files: [
        { name: "flow.yaml", language: "yaml", source: ROUTING_FLOW },
        { name: "tools/classify.sh", language: "bash", source: CLASSIFY },
        { name: "tools/page_oncall.sh", language: "bash", source: PAGE_ONCALL },
        { name: "tools/file_ticket.sh", language: "bash", source: FILE_TICKET },
      ],
      run:
        "heddle run flow.yaml --tools-dir ./tools \\\n" +
        `  --input '{"message": "the database is on fire"}'`,
      note:
        "The branch is a switch step in the document, not an if-statement. " +
        "Every tool is its own executable, which is why this column has four " +
        "files where the others have one.",
    },

    agent: {
      files: [{ name: "flow.yaml", language: "yaml", source: AGENT_FLOW }],
      run:
        "heddle run flow.yaml \\\n" +
        `  --input '{"query": "what is a heddle on a loom?"}'`,
      note:
        "One model call and nothing else, so this is the whole of the " +
        "format at its smallest: an input, an agent and an implicit " +
        "outcome, and no runtime to construct.",
    },

    shell: {
      files: [
        { name: "flow.yaml", language: "yaml", source: SHELL_FLOW },
        { name: "tools/bash.py", language: "python", source: BASH },
      ],
      run:
        "heddle run flow.yaml --tools-dir ./tools --safe \\\n" +
        "  --sandbox bubblewrap \\\n" +
        `  --input '{"task": "count the vowels in \\"weave agents from spec\\""}'`,
      note:
        "The only column where the confinement is part of the answer: " +
        "--safe --sandbox bubblewrap puts each command in its own namespace " +
        "with no $HOME and no writes outside the run's workspace.",
    },

    skills: {
      files: [
        { name: "flow.yaml", language: "yaml", source: SKILLS_FLOW },
        { name: "tools/list_skills.py", language: "python", source: LIST_SKILLS },
        { name: "tools/read_skill.py", language: "python", source: READ_SKILL },
        { name: "skills/tidy-a-csv.md", language: "markdown", source: TIDY_SKILL },
      ],
      run:
        "heddle run flow.yaml --tools-dir ./tools --mount ./skills \\\n" +
        `  --input '{"task": "tidy up the numbers in report.csv"}'`,
      note:
        "Skills are not a heddle concept either. The pattern is two tools " +
        "and a prompt, and every column writes the same one. What differs is " +
        "that the prompt and the tool shapes are a document, and --mount is " +
        "what decides the folder is there, rather than the process happening " +
        "to be started in the right directory.",
    },

    "tool-and-plugin": {
      files: [
        { name: "flow.yaml", language: "yaml", source: TOOL_AND_PLUGIN_FLOW },
        { name: "tools/shout.sh", language: "bash", source: SHOUT },
        { name: "reverse.js", language: "javascript", source: REVERSE_PLUGIN },
      ],
      run:
        "heddle run flow.yaml --tools-dir ./tools --plugin ./reverse.js \\\n" +
        `  --input '{"text": "weave agents from spec"}'`,
      note:
        "Both steps are out of the engine's process, the tool as a " +
        "subprocess and the plugin step in its own, and the flow names them " +
        "without knowing either is not a heddle type.",
    },

    "ag-ui": {
      files: [
        { name: "flow.yaml", language: "yaml", source: AG_UI_FLOW },
        { name: "tools/digest.py", language: "python", source: DIGEST },
        { name: "encoder.mjs", language: "javascript", source: ENCODER },
        { name: "encoder.json", language: "json", source: ENCODER_MANIFEST },
      ],
      run:
        "heddle run flow.yaml --tools-dir ./tools --plugin ./encoder.mjs \\\n" +
        "  --protocol ag-ui \\\n" +
        `  --input '{"question": "the sha-256 of: weave agents from spec"}'`,
      note:
        "The flow is the agent column again, unchanged. The rendering is " +
        "a plugin and a flag, not a property of the program. That is what " +
        "the other three have no equivalent of.",
    },
  },
};
