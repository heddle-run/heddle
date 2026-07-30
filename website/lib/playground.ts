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

export const EXAMPLES: Example[] = [
  TOOL_AND_PLUGIN,
  GUARDRAIL,
  BRANCHING,
  AGENT,
  SHELL,
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export const INTERPRETERS = ["sh", "bash", "python3", "node"] as const;
