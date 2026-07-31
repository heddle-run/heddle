export const API_BASE = (process.env.NEXT_PUBLIC_HEDDLE_API ?? "").replace(
  /\/+$/,
  "",
);

export interface RequestTool {
  name: string;
  source: string;
  interpreter: string;
}

export interface RequestPlugin {
  name: string;
  manifest: PluginManifest;
  source: string;
}

export interface PluginManifest {
  name: string;
  version: string;
  capabilities?: string[];
  components: Array<{
    componentType: string;
    kind?: "node" | "transform" | "component";
    inputs?: Array<{ title: string; type: string }>;
    outputs?: Array<{ title: string; type: string }>;
    branches?: string[];
    phase?: "pre" | "post" | "both";
    schema?: Record<string, unknown>;
  }>;
  /** Tools the plugin provides. `componentType` names the one implementing it. */
  tools?: Array<{
    name: string;
    componentType: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

export interface RunEvent {
  type: string;
  nodeName?: string;
  nodeType?: string;
  delta?: string;
  data?: unknown;
  level?: "debug" | "info" | "warn" | "error";
  state?: Record<string, unknown>;
  error?: { name?: string; type?: string; message: string };
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  duration?: number;
  message?: string;
}

export function appendEvent(log: RunEvent[], event: RunEvent): RunEvent[] {
  const last = log[log.length - 1];
  if (
    event.type === "token_delta" &&
    last?.type === "token_delta" &&
    last.nodeName === event.nodeName
  ) {
    return [
      ...log.slice(0, -1),
      { ...last, delta: (last.delta ?? "") + (event.delta ?? "") },
    ];
  }
  return [...log, event];
}

export interface Capabilities {
  version: string;
  allowRequestCode: boolean;
  acceptsFlowPath: boolean;
  sandbox: string | null;
  tools: string[];
  limits: Record<string, number>;
  runsInFlight: number;
}

export interface ValidationResult {
  valid: true;
  flow: string;
  startNode: string;
  nodes: { name: string; type: string }[];
}

export class EngineError extends Error {
  constructor(
    message: string,
    readonly type = "Error",
    readonly status?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function missingEndpoint(): EngineError {
  return new EngineError(
    "No engine endpoint is configured. Set NEXT_PUBLIC_HEDDLE_API to a running heddle-server.",
    "ConfigError",
  );
}

async function toError(res: Response): Promise<EngineError> {
  let message = `request failed with status ${res.status}`;
  let type = "Error";
  try {
    const body = (await res.json()) as { error?: { type: string; message: string } };
    if (body.error?.message) {
      message = body.error.message;
      type = body.error.type ?? type;
    }
  } catch {
  }
  return new EngineError(message, type, res.status);
}

export async function fetchCapabilities(
  signal?: AbortSignal,
): Promise<Capabilities> {
  if (!API_BASE) throw missingEndpoint();
  const res = await fetch(`${API_BASE}/v1/capabilities`, { signal });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as Capabilities;
}

export interface RunPayload {
  flow: string;
  inputs: Record<string, unknown>;
  tools: RequestTool[];
  plugins: RequestPlugin[];
}

function body(payload: RunPayload, withInputs: boolean): string {
  return JSON.stringify({
    flow: payload.flow,
    ...(withInputs ? { inputs: payload.inputs } : {}),
    ...(payload.tools.length > 0 ? { tools: payload.tools } : {}),
    ...(payload.plugins.length > 0 ? { plugins: payload.plugins } : {}),
  });
}

export async function validateFlow(
  payload: RunPayload,
  signal?: AbortSignal,
): Promise<ValidationResult> {
  if (!API_BASE) throw missingEndpoint();
  const res = await fetch(`${API_BASE}/v1/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(payload, false),
    signal,
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as ValidationResult;
}

function parseFrame(frame: string): RunEvent | undefined {
  let name = "message";
  const data: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return undefined;

  try {
    const parsed = JSON.parse(data.join("\n")) as RunEvent;
    return { ...parsed, type: parsed.type ?? name };
  } catch {
    return undefined;
  }
}

export async function* streamRun(
  payload: RunPayload,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  if (!API_BASE) throw missingEndpoint();

  const res = await fetch(`${API_BASE}/v1/runs?stream=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body(payload, true),
    signal,
  });

  if (!res.ok) throw await toError(res);
  if (!res.body) throw new EngineError("the engine returned an empty response");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const event = parseFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        if (event) yield event;
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export interface Example {
  id: string;
  title: string;
  blurb: string;
  needsKey?: boolean;
  flow: string;
  inputs: string;
  tools: RequestTool[];
  plugins: RequestPlugin[];
}

const SHOUT_TOOL: RequestTool = {
  name: "shout",
  interpreter: "sh",
  source: `read -r input

text=$(printf '%s' "$input" | sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

printf '{"shouted":"%s"}' "$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]')"
`,
};

const REVERSE_PLUGIN: RequestPlugin = {
  name: "reverse",
  manifest: {
    name: "playground-reverse",
    version: "1.0.0",
    capabilities: ["log", "emitEvent"],
    components: [
      {
        componentType: "ReverseNode",
        inputs: [{ title: "shouted", type: "string" }],
        outputs: [{ title: "reversed", type: "string" }],
      },
    ],
  },
  source: `serve({
  ReverseNode: {
    execute(input, ctx) {
      const text = String(input.shouted ?? input.text ?? "");

      // A line for a person. It is not the same as stderr: the engine keeps
      // only the last few kilobytes of that and shows it only when the
      // process fails, so a plugin that works has no way to say anything.
      ctx.log("info", "reversing " + text.length + " characters");

      // A structured report. You supply only the name — the engine publishes
      // it as plugin:ReverseNode:progress, so it can never be read as one of
      // the engine's own events.
      ctx.emitEvent("progress", { characters: text.length });

      return { output: { reversed: [...text].reverse().join("") } };
    },
  },
});
`,
};

const TOOL_AND_PLUGIN: Example = {
  id: "tool-and-plugin",
  title: "Tool and plugin",
  blurb: "A shell tool, then a node type a plugin adds. Both run in their own processes.",
  flow: `component_type: Flow
name: shout
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: shout
  - $component_ref: reverse
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_shout
    from_node: { $component_ref: start }
    to_node: { $component_ref: shout }
  - component_type: ControlFlowEdge
    name: shout_to_reverse
    from_node: { $component_ref: shout }
    to_node: { $component_ref: reverse }
  - component_type: ControlFlowEdge
    name: reverse_to_end
    from_node: { $component_ref: reverse }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: text
        type: string

  # A tool: an executable the engine runs as a subprocess.
  shout:
    component_type: ToolNode
    id: shout
    name: shout
    tool:
      component_type: ServerTool
      id: shout_tool
      name: shout
      description: Uppercases the text it is given

  # A plugin node. ReverseNode is not a heddle type — the plugin adds it.
  reverse:
    component_type: ReverseNode
    id: reverse
    name: reverse

  end:
    component_type: EndNode
    id: end
    name: end
`,
  inputs: `{
  "text": "weave agents from spec"
}
`,
  tools: [SHOUT_TOOL],
  plugins: [REVERSE_PLUGIN],
};

const GUARDRAIL: Example = {
  id: "guardrail",
  title: "A guardrail that refuses",
  blurb:
    "A transform inspects the agent's messages before the model call. Blocked here — change the input and the model answers.",
  flow: `component_type: Flow
name: guarded
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: assistant
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_assistant
    from_node: { $component_ref: start }
    to_node: { $component_ref: assistant }
  - component_type: ControlFlowEdge
    name: assistant_to_end
    from_node: { $component_ref: assistant }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: query
        type: string

  assistant:
    component_type: AgentNode
    id: assistant
    name: assistant
    agent:
      component_type: Agent
      id: inner
      name: assistant
      system_prompt: You are a concise, helpful assistant.

      # Never reached while the guardrail rejects — that is the point: a
      # blocked prompt costs nothing. Change the input to something allowed
      # and the model answers for real.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: model
        model_id: openrouter/free

      tools: []

      # Transforms travel with the agent, not the graph.
      transforms:
        - component_type: Blocklist
          id: guard
          name: guard
          phase: pre
          config:
            patterns:
              - password
              - credit card
            reason: that topic is blocked

  end:
    component_type: EndNode
    id: end
    name: end
`,
  inputs: `{
  "query": "what is my password"
}
`,
  tools: [],
  plugins: [
    {
      name: "blocklist",
      manifest: {
        name: "playground-guardrails",
        version: "1.0.0",
        components: [
          { componentType: "Blocklist", kind: "transform", phase: "pre" },
        ],
      },
      source: `serve({
  Blocklist: {
    apply(messages, ctx) {
      const config = ctx.node.config ?? {};
      const last = messages[messages.length - 1];
      const content = String(last?.content ?? "");

      for (const pattern of config.patterns ?? []) {
        if (new RegExp(pattern, "i").test(content)) {
          return {
            action: "reject",
            reason: config.reason ?? ("matched /" + pattern + "/"),
          };
        }
      }
      return { action: "pass" };
    },
  },
});
`,
    },
  ],
};

const BRANCHING: Example = {
  id: "branching",
  title: "Routing on a branch",
  blurb:
    "A tool classifies the input, then a BranchingNode routes on its answer. No plugin, no model.",
  flow: `component_type: Flow
name: triage
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: classify
  - $component_ref: route
  - $component_ref: urgent
  - $component_ref: normal
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_classify
    from_node: { $component_ref: start }
    to_node: { $component_ref: classify }
  - component_type: ControlFlowEdge
    name: classify_to_route
    from_node: { $component_ref: classify }
    to_node: { $component_ref: route }

  # One edge per branch the mapping can produce.
  - component_type: ControlFlowEdge
    name: route_urgent
    from_node: { $component_ref: route }
    from_branch: urgent
    to_node: { $component_ref: urgent }
  - component_type: ControlFlowEdge
    name: route_normal
    from_node: { $component_ref: route }
    from_branch: normal
    to_node: { $component_ref: normal }

  - component_type: ControlFlowEdge
    name: urgent_to_end
    from_node: { $component_ref: urgent }
    to_node: { $component_ref: end }
  - component_type: ControlFlowEdge
    name: normal_to_end
    from_node: { $component_ref: normal }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: message
        type: string

  classify:
    component_type: ToolNode
    id: classify
    name: classify
    tool:
      component_type: ServerTool
      id: classify_tool
      name: classify
      description: Labels the message urgent or normal

  # Routes on branching_mapping_key, which the tool above sets.
  route:
    component_type: BranchingNode
    id: route
    name: route
    mapping:
      urgent: urgent
      normal: normal
      DEFAULT_BRANCH: normal

  urgent:
    component_type: ToolNode
    id: urgent
    name: urgent
    tool:
      component_type: ServerTool
      id: urgent_tool
      name: page_oncall
      description: Pretends to page whoever is on call

  normal:
    component_type: ToolNode
    id: normal
    name: normal
    tool:
      component_type: ServerTool
      id: normal_tool
      name: file_ticket
      description: Pretends to file an ordinary ticket

  end:
    component_type: EndNode
    id: end
    name: end
`,
  inputs: `{
  "message": "the database is on fire"
}
`,
  tools: [
    {
      name: "classify",
      interpreter: "sh",
      source: `read -r input

# Anything mentioning fire, outage or down is urgent; everything else is not.
if printf '%s' "$input" | grep -qiE 'fire|outage|down|urgent'; then
  printf '{"branching_mapping_key":"urgent"}'
else
  printf '{"branching_mapping_key":"normal"}'
fi
`,
    },
    {
      name: "page_oncall",
      interpreter: "sh",
      source: `read -r input
printf '{"action":"paged the on-call engineer"}'
`,
    },
    {
      name: "file_ticket",
      interpreter: "sh",
      source: `read -r input
printf '{"action":"filed a ticket for the morning"}'
`,
    },
  ],
  plugins: [],
};

const AGENT: Example = {
  id: "agent",
  title: "An agent",
  blurb:
    "A single agent calling a real model. Runs as-is: the engine supplies a free model when the spec names no credential.",
  flow: `component_type: Flow
name: ask
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: assistant
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_assistant
    from_node: { $component_ref: start }
    to_node: { $component_ref: assistant }
  - component_type: ControlFlowEdge
    name: assistant_to_end
    from_node: { $component_ref: assistant }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: query
        type: string

  assistant:
    component_type: AgentNode
    id: assistant
    name: assistant
    agent:
      component_type: Agent
      id: inner
      name: assistant
      system_prompt: Answer in one sentence.

      # No api_key and no url, so the engine uses the free model it was
      # configured with. To call your own provider instead, supply both:
      #
      #   component_type: OpenAiCompatibleConfig
      #   url: https://api.openai.com/v1
      #   api_key: sk-your-own-key
      #
      # Both together, always. A spec naming a url without a key is refused
      # rather than handed the engine's own, which would post it there.
      #
      # Running this file locally, you would instead write
      #
      #   api_key: $OPENAI_API_KEY
      #
      # which reads your environment. The playground refuses that form: there,
      # the spec is yours and the environment is yours, so a reference resolves
      # to your own secret. Here the spec arrives from a stranger and the
      # environment belongs to the engine, and the reference is not limited to
      # model keys -- $ANYTHING would be read and sent wherever the same spec
      # pointed.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: model
        model_id: openrouter/free

      tools: []

  end:
    component_type: EndNode
    id: end
    name: end
`,
  inputs: `{
  "query": "what is a heddle on a loom?"
}
`,
  tools: [],
  plugins: [],
};

/* The comparison view writes this same assistant in four frameworks, and its
   heddle column hands the reader here — so the flow below is that column's
   flow, with the one change the playground requires: no api_key, because a
   spec that arrives from a stranger may not name one. */
const RESEARCH: Example = {
  id: "research",
  title: "A research assistant",
  blurb:
    "One agent, two typed tools, looping until it has an answer. The comparison writes this one four ways.",
  flow: `component_type: Flow
name: research-assistant
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: researcher
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_researcher
    from_node: { $component_ref: start }
    to_node: { $component_ref: researcher }
  - component_type: ControlFlowEdge
    name: researcher_to_end
    from_node: { $component_ref: researcher }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: question
        type: string

  researcher:
    component_type: AgentNode
    id: researcher
    name: researcher
    outputs:
      - title: result
        type: string
    agent:
      component_type: Agent
      id: research_agent
      name: research-agent
      system_prompt: >-
        You are a research assistant. Answer the question. Use web_search
        when you need current information, and calculator for arithmetic.

      # No api_key and no url, so the engine supplies the free model it was
      # configured with -- see the agent example for why that pair is
      # all-or-nothing.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: model
        model_id: openrouter/free

      # Declaring a tool's inputs is what gives the model a shape to fill in:
      # they become the function's parameters.
      tools:
        - component_type: ServerTool
          id: web_search_tool
          name: web_search
          description: Search the web for information
          inputs:
            - title: query
              type: string
          outputs:
            - title: results
              type: string

        - component_type: ServerTool
          id: calculator_tool
          name: calculator
          description: Evaluate a mathematical expression
          inputs:
            - title: expression
              type: string
          outputs:
            - title: result
              type: string

  end:
    component_type: EndNode
    id: end
    name: end
    inputs:
      - title: result
        type: string
`,
  inputs: `{
  "question": "How tall is the Eiffel Tower in feet?"
}
`,
  tools: [
    {
      name: "web_search",
      interpreter: "python3",
      source: `import json, sys

args = json.load(sys.stdin)
query = args.get("query", "")

# A stub, so that the example runs with nothing to sign up for. The spec
# above does not know or care -- swap this file for a real search and the
# document is unchanged.
json.dump({"results": f"Search results for: {query}"}, sys.stdout)
`,
    },
    {
      name: "calculator",
      interpreter: "python3",
      source: `import json, sys

args = json.load(sys.stdin)
expression = args.get("expression", "0")

# The model picks this string, so a bare eval() would be arbitrary code
# execution. No letters, no imports.
if set(expression) - set("0123456789.+-*/() "):
    result = "unsupported expression"
else:
    result = str(eval(expression))

json.dump({"result": result}, sys.stdout)
`,
    },
  ],
  plugins: [],
};

const BASH_TOOL: RequestTool = {
  name: "bash",
  interpreter: "python3",
  source: `import json, os, subprocess, sys

data = json.load(sys.stdin)
command = (data.get("command") or "").strip()

# $HEDDLE_WORKSPACE is the one writable directory, and it is shared by every
# tool call this agent makes -- so a file one command writes is there for the
# next. It is deleted when the run ends.
workdir = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()

try:
    done = subprocess.run(
        ["bash", "-c", command],
        cwd=workdir,
        # Nothing interactive can work here: this process's stdin was the JSON
        # above, and a command that waits for a terminal would just time out.
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=20,
    )
    stdout, stderr, code = done.stdout, done.stderr, done.returncode
except subprocess.TimeoutExpired:
    stdout, stderr, code = "", "command timed out after 20s", 124

# Exit 0 whatever happened. A tool that exits non-zero is a broken tool and the
# engine abandons the round -- which would take the error message away from the
# one reader who can act on it.
json.dump(
    {"stdout": stdout[:4000], "stderr": stderr[:2000], "exit_code": code},
    sys.stdout,
)
`,
};

const SHELL: Example = {
  id: "shell",
  title: "An agent with a shell",
  blurb:
    "One tool that runs any command, and a model deciding what to run. Python and Node are on PATH in the sandbox.",
  flow: `component_type: Flow
name: shell
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: shell
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_shell
    from_node: { $component_ref: start }
    to_node: { $component_ref: shell }
  - component_type: ControlFlowEdge
    name: shell_to_end
    from_node: { $component_ref: shell }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: task
        type: string

  shell:
    component_type: AgentNode
    id: shell
    name: shell
    agent:
      component_type: Agent
      id: inner
      name: shell
      system_prompt: |
        You run shell commands to answer the task. python3 and node are both on
        PATH; use whichever suits the work.

        Each call is a fresh shell, so cd and exported variables do not survive
        to the next one -- chain what depends on itself into a single command.
        Read exit_code every time: a zero exit is the only evidence a command
        did what you meant. Nothing interactive works, and a command is killed
        after 20 seconds.

        Answer in one or two sentences, saying what you ran and what came back.

      # No api_key and no url, so the engine supplies the free model it was
      # configured with -- see the agent example for why that pair is
      # all-or-nothing.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: model
        model_id: openrouter/free

      # Declaring the inputs is what gives the model a shape to fill in: they
      # become the function's parameters, and a tool with none is a tool it can
      # only call empty.
      tools:
        - component_type: ServerTool
          id: bash_tool
          name: bash
          description: >-
            Run a shell command and return its stdout, stderr and exit code.
            Runs in $HEDDLE_WORKSPACE. python3 and node are on PATH. Each call
            is a fresh shell and commands are killed after 20 seconds.
          inputs:
            - title: command
              type: string
          outputs:
            - title: stdout
              type: string
            - title: stderr
              type: string
            - title: exit_code
              type: integer

  end:
    component_type: EndNode
    id: end
    name: end
`,
  inputs: `{
  "task": "count the vowels in \\"weave agents from spec\\" with python, then reverse the string with node"
}
`,
  tools: [BASH_TOOL],
  plugins: [],
};

/* A skill is a folder of instructions on somebody's disk, and there is no disk
   here: the playground engine takes a request and installs nothing. So the
   skills travel as data inside the plugin, which reaches the model through two
   tools rather than through the prompt. That is not a workaround for the
   playground -- it is the arrangement the mechanism wants. Names and
   descriptions are cheap and always in context; a body is a tool call the model
   decided to make, on a task it decided the skill covers. Paste twenty skills
   into the system prompt instead and you have not built skills, you have built
   a long prompt. */
const SKILLS_PLUGIN: RequestPlugin = {
  name: "skills",
  manifest: {
    name: "playground-skills",
    version: "1.0.0",
    // Declared because a tool's "componentType" has to name a component this
    // plugin provides -- the manifest is checked before anything runs, so a
    // typo is refused at load rather than at the call. Nothing implements it:
    // callTool dispatches on the tool's name, not on the component.
    components: [{ componentType: "Skills", kind: "component" }],
    tools: [
      {
        name: "list_skills",
        componentType: "Skills",
        description:
          "List every skill: its name and one line on when it applies. Call this first.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "read_skill",
        componentType: "Skills",
        description: "Return the full text of one skill, by the name list_skills gave.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "the skill's name" },
          },
          required: ["name"],
        },
      },
    ],
  },
  source: `const SKILLS = [
  {
    name: 'tabular-summary',
    description:
      'Total, average or rank rows of data -- a CSV, a TSV, a pasted table. ' +
      'Read this before doing arithmetic over more than a couple of rows.',
    body: \`Do not add the rows up yourself. Put them in a file and let a script do it.

1. write_file the rows verbatim to data.csv. Do not retype a figure, reorder a
   column, or drop the header.
2. write_file a summarise.py that reads data.csv with the csv module and prints
   one line per figure you were asked for.
3. bash: python3 summarise.py
4. Report only numbers that appeared in its output.

If exit_code is not 0, fix the script and run it again. Never fall back to
working the answer out in your head -- that is the mistake this procedure exists
to prevent.

Round money in the script, to two places, rather than in the sentence you write.\`,
  },
  {
    name: 'date-arithmetic',
    description:
      'Days between two dates, a weekday, or a date some interval away. Read ' +
      'this before stating any date you did not copy from the input.',
    body: \`Counting days by hand goes wrong at month ends and in February. Run it.

  bash: python3 -c "from datetime import date, timedelta; print((date(2026,3,1) - date(2025,11,14)).days)"

A weekday is print(date(2026,3,1).strftime('%A')). A date n days on is
print(date(2026,3,1) + timedelta(days=n)).

Quote the number the command printed. If a date arrives without a year, say
which year you took it to be instead of choosing one silently.\`,
  },
  {
    name: 'incident-note',
    description:
      'The house format for writing up something that broke -- an outage, a ' +
      'failed job, a bad deploy. Read this before writing any incident summary.',
    body: \`Five lines, this order, one sentence each. No headings, no adjectives,
no names.

WHAT:  the behaviour somebody outside would have noticed.
WHEN:  the window in UTC, and how long it lasted.
FOUND: what noticed it -- an alarm, a customer, somebody looking.
CAUSE: the change or condition that produced it.
GUARD: the check that would have caught it before a user did.

Write "not established" for CAUSE when it is not established. A plausible cause
stated as a settled one is the failure this format exists to prevent.\`,
  },
];

serve(
  // No component handlers at all. "Skills" exists in the manifest so the two
  // tools below have something to name; neither is dispatched through it.
  {},
  {
    tools: {
      // The index, and only the index. Sending the bodies here would put every
      // skill in the conversation on the first call, which is the whole thing
      // this arrangement avoids.
      list_skills: async () => ({
        output: {
          skills: SKILLS.map((skill) => ({
            name: skill.name,
            description: skill.description,
          })),
        },
      }),

      read_skill: async (input) => {
        const asked = String(input.name || '').trim().toLowerCase();
        const skill = SKILLS.find((entry) => entry.name === asked);

        // Answered, not thrown. A tool that fails takes the round with it, and
        // the model that mistyped the name is the one reader who can correct it.
        if (!skill) {
          return {
            output: {
              body:
                'there is no skill called "' + asked + '". There are: ' +
                SKILLS.map((entry) => entry.name).join(', ') + '.',
            },
          };
        }

        return { output: { name: skill.name, body: skill.body } };
      },
    },
  },
);
`,
};

/* Every path is taken relative to $HEDDLE_WORKSPACE, and refused if it climbs
   out. Here the sandbox has already made that true and this is belt and braces.
   Run the same tool locally under heddle run without --safe and there is no
   workspace: it falls back to the working directory, which is then the whole of
   what the model can reach. Start it somewhere empty. */
const WORKSPACE_PATH = `import json, os, sys

data = json.load(sys.stdin)
path = (data.get("path") or "").strip()

root = os.path.realpath(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd())
target = os.path.realpath(os.path.join(root, path))
inside = path and (target == root or target.startswith(root + os.sep))
`;

const WRITE_FILE_TOOL: RequestTool = {
  name: "write_file",
  interpreter: "python3",
  source: `${WORKSPACE_PATH}
content = data.get("content") or ""

if not inside:
    json.dump({"result": "refused: path must stay inside the workspace"}, sys.stdout)
    sys.exit(0)

os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, "w") as handle:
    handle.write(content)

json.dump({"result": "wrote %d bytes to %s" % (len(content), path)}, sys.stdout)
`,
};

const READ_FILE_TOOL: RequestTool = {
  name: "read_file",
  interpreter: "python3",
  source: `${WORKSPACE_PATH}
if not inside:
    json.dump({"content": "refused: path must stay inside the workspace"}, sys.stdout)
    sys.exit(0)

try:
    with open(target) as handle:
        content = handle.read()[:8000]
except OSError as err:
    # A message rather than a crash, for the reason the plugin returns one: the
    # model picked this path and can pick another once it is told.
    content = "could not read %s: %s" % (path, err)

json.dump({"content": content}, sys.stdout)
`,
};

const SKILLS: Example = {
  id: "skills",
  title: "An agent with skills",
  blurb:
    "Procedures the model loads only when it decides it needs them. The index is always in context; a body costs a tool call.",
  flow: `component_type: Flow
name: skills
start_node: { $component_ref: start }

nodes:
  - $component_ref: start
  - $component_ref: assistant
  - $component_ref: end

control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_assistant
    from_node: { $component_ref: start }
    to_node: { $component_ref: assistant }
  - component_type: ControlFlowEdge
    name: assistant_to_end
    from_node: { $component_ref: assistant }
    to_node: { $component_ref: end }

$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - title: task
        type: string

  assistant:
    component_type: AgentNode
    id: assistant
    name: assistant
    agent:
      component_type: Agent
      id: inner
      name: assistant

      # The contract, and the only place it is stated. A model that is not told
      # to look will not look, and a skill nobody reads is a file.
      system_prompt: |
        You have skills: short written procedures for jobs like this one. Their
        text is not in this prompt. list_skills returns every skill's name and
        description; read_skill returns one body.

        Call list_skills first, on every task, before anything else. If a
        description covers the task, read that skill and follow it exactly: it
        says how the job is done here, and that outranks how you would otherwise
        do it. If none covers it, say so in one line and work the task out
        yourself.

        write_file and read_file take a path relative to the workspace. bash
        runs a command there, with python3 and node on PATH. Each bash call is a
        fresh shell, so cd does not carry to the next one, and a command is
        killed after 20 seconds. Read exit_code every time.

        Finish with a short answer that names the skill you followed.

      # No api_key and no url, so the engine supplies the free model it was
      # configured with -- see the agent example for why that pair is
      # all-or-nothing.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: model
        model_id: openrouter/free

      tools:
        # Named, and nothing else. The plugin's manifest already carries a
        # description and a parameter schema for each, and a spec that declares
        # neither takes both from there -- so what the model is told about these
        # two tools is the plugin's own account of them rather than a copy kept
        # in step by hand.
        - component_type: ServerTool
          id: list_skills_tool
          name: list_skills

        - component_type: ServerTool
          id: read_skill_tool
          name: read_skill

        # The other three are submitted files with no manifest behind them, so
        # they declare their own shape here.
        #
        # write_file and bash together are a shell: whatever the model can write
        # it can then run. Here that is a throwaway workspace the sandbox
        # deletes when the agent finishes. Where it would not be, the gate is
        # the toolCall seam -- examples/policies/ ships an ApprovalGate that
        # reads the arguments the model chose and refuses the call before it is
        # made.
        - component_type: ServerTool
          id: write_file_tool
          name: write_file
          description: >-
            Write a file in the workspace. The path is relative to it, and a
            path that climbs out is refused.
          inputs:
            - title: path
              type: string
            - title: content
              type: string
          outputs:
            - title: result
              type: string

        - component_type: ServerTool
          id: read_file_tool
          name: read_file
          description: Read a file from the workspace, by a path relative to it.
          inputs:
            - title: path
              type: string
          outputs:
            - title: content
              type: string

        - component_type: ServerTool
          id: bash_tool
          name: bash
          description: >-
            Run a shell command in the workspace and return its stdout, stderr
            and exit code. Each call is a fresh shell and commands are killed
            after 20 seconds.
          inputs:
            - title: command
              type: string
          outputs:
            - title: stdout
              type: string
            - title: stderr
              type: string
            - title: exit_code
              type: integer

  end:
    component_type: EndNode
    id: end
    name: end
`,
  inputs: `{
  "task": "Total these expenses by category and say which category cost the most.\\n\\ndate,category,amount\\n2026-03-02,travel,412.50\\n2026-03-04,meals,38.20\\n2026-03-09,travel,96.00\\n2026-03-11,software,240.00\\n2026-03-18,meals,52.75"
}
`,
  tools: [WRITE_FILE_TOOL, READ_FILE_TOOL, BASH_TOOL],
  plugins: [SKILLS_PLUGIN],
};

export const EXAMPLES: Example[] = [
  TOOL_AND_PLUGIN,
  GUARDRAIL,
  BRANCHING,
  AGENT,
  RESEARCH,
  SHELL,
  SKILLS,
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

/** The example an id names, for the comparison's handover to the editor. */
export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((example) => example.id === id);
}

export const INTERPRETERS = ["sh", "bash", "python3", "node"] as const;
