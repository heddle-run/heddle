/**
 * Client for the heddle HTTP engine.
 *
 * The site is a static export, so there is no server of ours between the
 * browser and the engine — this talks to it directly, which is why the engine
 * needs an allowed CORS origin. The endpoint is read from the environment at
 * build time; when it is absent the playground says so rather than failing on
 * the first request.
 */

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
  /**
   * What the plugin provides, as data. The engine reads this while parsing, so
   * a flow's shape is known without executing anyone's code — which is what
   * makes accepting a submitted plugin reasonable at all.
   */
  manifest: PluginManifest;
  /** Handler source. Calls `serve()`, which the engine prepends. */
  source: string;
}

/** The declarative half of a submitted plugin. */
export interface PluginManifest {
  name: string;
  version: string;
  components: Array<{
    componentType: string;
    kind?: "node" | "transform" | "component";
    inputs?: Array<{ title: string; type: string }>;
    outputs?: Array<{ title: string; type: string }>;
    branches?: string[];
    /** Transforms only: which side of the model call this runs on. */
    phase?: "pre" | "post" | "both";
    /** JSON Schema the spec component is checked against while parsing. */
    schema?: Record<string, unknown>;
  }>;
}

/** A runner event, as it arrives over the wire. */
export interface RunEvent {
  type: string;
  nodeName?: string;
  nodeType?: string;
  state?: Record<string, unknown>;
  /**
   * Two shapes reach this field, because two things produce it. A runner event
   * carries a serialized `Error`, so `name`; the stream's own `error` frame
   * carries the engine's error body, so `type`. Both always carry a message.
   */
  error?: { name?: string; type?: string; message: string };
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  duration?: number;
  message?: string;
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

/** An error the engine reported, carrying its structured type. */
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

/** Turn a failed response into an EngineError, whatever shape it came back in. */
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
    // A non-JSON failure is usually a proxy or a CORS rejection rather than
    // the engine, and the status is the only thing worth reporting.
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

/** The request body shared by both endpoints. */
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
    // Omitted entirely when empty: a server without --allow-request-code
    // refuses the fields outright, and an empty array would still trip that.
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

/** One `event:`/`data:` frame from the stream. */
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
    // `error` frames carry the error body rather than a runner event, so they
    // arrive without a type of their own.
    return { ...parsed, type: parsed.type ?? name };
  } catch {
    return undefined;
  }
}

/**
 * Run a flow, yielding events as they arrive.
 *
 * A POST rather than an EventSource: the flow does not belong in a query
 * string, so the stream is read off the response body directly. Compilation
 * happens before the engine opens the stream, which is why a bad flow arrives
 * here as a real 4xx and not as a 200 followed by an error frame.
 */
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

      // Frames are separated by a blank line. A chunk boundary can fall
      // anywhere, so anything after the last separator stays buffered.
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

// ---------------------------------------------------------------------------
// What the playground opens with
// ---------------------------------------------------------------------------

/**
 * A flow that runs without model credentials.
 *
 * Deliberately tool-only. An agent node would be a better advertisement, but
 * it would also fail on any engine without an API key, and a playground whose
 * first run fails teaches the wrong thing.
 */

// ---------------------------------------------------------------------------
// Examples
//
// Three of the four run without a model credential, which is deliberate: the
// first thing a visitor does should work. The guardrail is free for a reason
// worth knowing — a `pre` transform that rejects means heddle never calls the
// model at all, so a blocked prompt costs nothing.
// ---------------------------------------------------------------------------

export interface Example {
  id: string;
  /** Shown on the selector. */
  title: string;
  /** One line on what the example demonstrates. */
  blurb: string;
  /** True when running it needs the caller's own model credential. */
  needsKey?: boolean;
  flow: string;
  inputs: string;
  tools: RequestTool[];
  plugins: RequestPlugin[];
}

/** A tool: an executable the engine runs as a subprocess. */
const SHOUT_TOOL: RequestTool = {
  name: "shout",
  interpreter: "sh",
  source: `read -r input

text=$(printf '%s' "$input" | sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

printf '{"shouted":"%s"}' "$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]')"
`,
};

/**
 * A plugin node: a component type the engine does not ship.
 *
 * The manifest declares the type as data, so the engine learns the flow's shape
 * while parsing it and never runs this source to find out. The source only says
 * what the node does — `serve()` is supplied by the engine.
 */
const REVERSE_PLUGIN: RequestPlugin = {
  name: "reverse",
  manifest: {
    name: "playground-reverse",
    version: "1.0.0",
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
    execute(input) {
      const text = String(input.shouted ?? input.text ?? "");
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

/**
 * A guardrail, and the reason it is free to run.
 *
 * A transform is not a node: it hangs off `Agent.transforms` and sees the
 * agent's *messages* around the model call, which is what lets it refuse one.
 * A `pre` transform that rejects means the model is never called — so this
 * example reaches a real AgentNode without a credential, and the llm_config
 * below is never dialled.
 */
const GUARDRAIL: Example = {
  id: "guardrail",
  title: "A guardrail that refuses",
  blurb:
    "A transform inspects the agent's messages before the model call. Rejecting skips the call entirely, so this runs without a key.",
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

      # Never reached while the guardrail rejects. Put your own key here and
      # ask something allowed to see the model actually answer.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: gpt
        model_id: gpt-4o-mini
        api_key: sk-put-your-own-key-here

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

/** Routing: a branch decides which of two paths a run takes. */
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

/**
 * The real thing: an agent calling a model with the caller's own key.
 *
 * Pointed at OpenRouter's free router rather than OpenAI, because the barrier
 * matters more than the model here — an OpenRouter account is free and takes
 * no card, where a useful OpenAI key does not. `openrouter/free` picks among
 * the free models on its own.
 *
 * A key is still needed: OpenRouter answers 401 without one, free model or
 * not. heddle holds none, so it has to come from the spec.
 */
const AGENT: Example = {
  id: "agent",
  title: "An agent, with your key",
  blurb:
    "A single agent calling a model through OpenRouter's free router. Needs a free OpenRouter key, pasted into the spec.",
  needsKey: true,
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

      # Any OpenAI-compatible endpoint works. OpenRouter's free router is used
      # here because an account costs nothing and needs no card.
      llm_config:
        component_type: OpenAiCompatibleConfig
        id: llm
        name: openrouter
        url: https://openrouter.ai/api/v1
        model_id: openrouter/free

        # Replace this. Get one at openrouter.ai/keys — free models still need
        # a key. It is sent to the engine to reach the model and is not stored,
        # but it does leave your browser, so use one you can revoke.
        api_key: sk-or-v1-REPLACE-WITH-YOUR-OPENROUTER-KEY

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

export const EXAMPLES: Example[] = [
  TOOL_AND_PLUGIN,
  GUARDRAIL,
  BRANCHING,
  AGENT,
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

export const INTERPRETERS = ["sh", "bash", "python3", "node"] as const;
