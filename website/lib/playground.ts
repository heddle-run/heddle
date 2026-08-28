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

/**
 * A file the run finds in its workspace, carried in the request beside the code.
 *
 * The caller's own bytes, at a path relative to the workspace root — never a
 * path on the engine, which is not the caller's to read. It is how content
 * reaches a tool without being installed on the engine or pasted into a prompt.
 */
export interface RequestFile {
  path: string;
  content: string;
}

/**
 * The kinds a manifest can declare, as the engine spells them.
 *
 * The playground reads exactly one of them — `encoder`, because an encoder is
 * the only kind that changes what comes back down the wire. The rest are here
 * because a manifest travels through the editor untouched, and a union that
 * omitted them would make a manifest the engine accepts impossible to type.
 */
export type ManifestKind =
  | "node"
  | "transform"
  | "component"
  | "provider"
  | "middleware"
  | "encoder";

export interface PluginManifest {
  name: string;
  version: string;
  capabilities?: string[];
  components: Array<{
    componentType: string;
    kind?: ManifestKind;
    inputs?: Array<{ title: string; type: string }>;
    outputs?: Array<{ title: string; type: string }>;
    branches?: string[];
    phase?: "pre" | "post" | "both";
    schema?: Record<string, unknown>;
    /** An encoder only: the name a run puts in `?protocol=` to ask for it. */
    protocol?: string;
    /** An encoder only: the content type of the response it produces. */
    contentType?: string;
  }>;
  /** Tools the plugin provides. `componentType` names the one implementing it. */
  tools?: Array<{
    name: string;
    componentType: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  }>;
}

/** heddle's own rendering, and the name a run can ask for it by. */
export const BUILTIN_PROTOCOL = "heddle";

/**
 * The protocols these plugins can render a run in.
 *
 * An encoder is a submittable kind: it renders one run for the caller who asked
 * and cannot alter it, so it may ride in the request body the way a tool does.
 * That is why this reads the manifests in the editor rather than asking the
 * engine — the engine will not have heard of the protocol until it is sent one.
 */
export function encoderProtocols(plugins: RequestPlugin[]): string[] {
  const protocols = new Set<string>();

  for (const plugin of plugins) {
    for (const component of plugin.manifest.components) {
      if (component.kind === "encoder" && component.protocol) {
        protocols.add(component.protocol);
      }
    }
  }
  return [...protocols];
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
  files: RequestFile[];
  /** The rendering to ask for. Absent, or `heddle`, is heddle's own. */
  protocol?: string;
}

function body(payload: RunPayload, withInputs: boolean): string {
  return JSON.stringify({
    flow: payload.flow,
    ...(withInputs ? { inputs: payload.inputs } : {}),
    ...(payload.tools.length > 0 ? { tools: payload.tools } : {}),
    ...(payload.plugins.length > 0 ? { plugins: payload.plugins } : {}),
    ...(payload.files.length > 0 ? { files: payload.files } : {}),
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

/**
 * Read one SSE frame, and decide what to call it.
 *
 * Two kinds of frame come down this stream and they are labelled differently.
 *
 * heddle's own frames are **named**: `event: node_start`, and a body that
 * repeats the name in a `type`. A plugin encoder's frames are **nameless** —
 * `data:` alone, with the protocol's own type inside the body — because a
 * protocol like AG-UI names its events in its own vocabulary and heddle has no
 * business stamping a second name on the outside.
 *
 * So: a named frame is called by its name, and a nameless one by the type in
 * its body. Preferring the body's `type` for both, as this did, is wrong on
 * exactly one frame and it is the one that matters. When a run fails the engine
 * writes `event: error` with the *error body* — `{ type, message }`, where the
 * type is the error's class. Reading that as the event's type labelled the row
 * `RunError`, which is in no vocabulary at all: the log did not tint it, no
 * branch here matched it, and the message was dropped on the floor. A failed run
 * showed one unremarkable grey line and no reason.
 *
 * That frame's body is an error, not an event, so it goes where an error goes.
 * `RunLog` and `usePlayground` were both already reading `event.error` for it.
 */
function parseFrame(frame: string): RunEvent | undefined {
  let name: string | undefined;
  const data: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) name = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trim());
  }
  if (data.length === 0) return undefined;

  const body = parseBody(data.join("\n"));
  if (!body) return undefined;

  if (name === "error") return { type: "error", error: asError(body) };
  return { ...body, type: name ?? body.type ?? "message" };
}

function parseBody(text: string): RunEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as RunEvent;
  } catch {
    return undefined;
  }
}

/**
 * The body of `event: error`, which is an error rather than an event: its
 * `type` is the class the engine raised, and there is no `message` above it.
 */
function asError(body: RunEvent): NonNullable<RunEvent["error"]> {
  return {
    type: body.type || "Error",
    message: body.message ?? "the run failed",
  };
}

export async function* streamRun(
  payload: RunPayload,
  signal?: AbortSignal,
): AsyncGenerator<RunEvent> {
  if (!API_BASE) throw missingEndpoint();

  /* `stream` and `protocol` travel together on purpose: a protocol names how
     the run's events are rendered, and the buffered response carries no events
     at all, so the engine answers 400 to one without the other. This function
     is the streaming one, so `stream=true` is unconditional. */
  const query = new URLSearchParams({ stream: "true" });
  if (payload.protocol && payload.protocol !== BUILTIN_PROTOCOL) {
    query.set("protocol", payload.protocol);
  }

  const res = await fetch(`${API_BASE}/v1/runs?${query.toString()}`, {
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
  files: RequestFile[];
  /** The rendering to select when this example is loaded. */
  protocol?: string;
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
  blurb: "A shell tool, then a step type a plugin adds. Both run in their own processes.",
  flow: `weave: 1
name: shout

inputs:
  text: string

# A tool: an executable the engine runs as a subprocess. The declaration is
# the contract — a tool step's outputs are checked against it.
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

  # A plugin step. ReverseNode is not a heddle type — the plugin adds it.
  # It receives the resolved "with" block, nothing else.
  - name: reverse
    use: ReverseNode
    with:
      shouted: '{{shout.shouted}}'

outcomes:
  done:
    reversed: '{{reverse.reversed}}'
`,
  inputs: `{
  "text": "weave agents from spec"
}
`,
  tools: [SHOUT_TOOL],
  plugins: [REVERSE_PLUGIN],
  files: [],
};

const GUARDRAIL: Example = {
  id: "guardrail",
  title: "A guardrail that refuses",
  blurb:
    "A transform inspects the agent's messages before the model call. Blocked here — change the input and the model answers.",
  flow: `weave: 1
name: guarded

inputs:
  query: string

agent:
  # Never reached while the guardrail rejects — that is the point: a
  # blocked prompt costs nothing. Change the input to something allowed
  # and the model answers for real.
  model:
    provider: openai
    model: openrouter/free

  prompt: |
    You are a concise, helpful assistant. Answer the question:

    {{inputs.query}}

  # Transforms travel with the agent, not the graph. The keys beside
  # "use" are the transform's own config.
  transforms:
    - use: Blocklist
      phase: pre
      patterns:
        - password
        - credit card
      reason: that topic is blocked
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
      // The keys the spec wrote beside "use" arrive spread onto the
      // component itself, so the config is read straight off ctx.node.
      const { patterns = [], reason } = ctx.node ?? {};
      const last = messages[messages.length - 1];
      const content = String(last?.content ?? "");

      for (const pattern of patterns) {
        if (new RegExp(pattern, "i").test(content)) {
          return {
            action: "reject",
            reason: reason ?? ("matched /" + pattern + "/"),
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
  files: [],
};

const BRANCHING: Example = {
  id: "branching",
  title: "Routing on a switch",
  blurb:
    "A tool classifies the input, then a switch routes on its answer. No plugin, no model.",
  flow: `weave: 1
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
    description: Pretends to page whoever is on call
    outputs:
      action: string
  file_ticket:
    description: Pretends to file an ordinary ticket
    outputs:
      action: string

steps:
  - name: classify
    tool: classify
    with:
      message: '{{inputs.message}}'

  # Routes on the label the tool wrote. "else" is required — a switch says
  # where every unmatched value goes, there is no implicit default.
  - name: route
    switch: '{{classify.label}}'
    cases:
      urgent: page
    else: file

  # Without "then" a step falls through to the next one, so each branch
  # names its own outcome.
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
  printf '{"label":"urgent"}'
else
  printf '{"label":"normal"}'
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
  files: [],
};

const AGENT: Example = {
  id: "agent",
  title: "An agent",
  blurb:
    "A single agent calling a real model. Runs as-is: the engine supplies a free model when the spec names no credential.",
  flow: `weave: 1
name: ask

inputs:
  query: string

# A document with a top-level agent and no steps is a one-step flow.
agent:
  # No api_key and no url, so the engine uses the free model it was
  # configured with. To call your own provider instead, supply both:
  #
  #   provider: openai-compatible
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
  model:
    provider: openai
    model: openrouter/free

  prompt: |
    Answer in one sentence.

    {{inputs.query}}
`,
  inputs: `{
  "query": "what is a heddle on a loom?"
}
`,
  tools: [],
  plugins: [],
  files: [],
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
  flow: `weave: 1
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
  # No api_key and no url, so the engine supplies the free model it was
  # configured with -- see the agent example for why that pair is
  # all-or-nothing.
  model:
    provider: openai
    model: openrouter/free

  prompt: |
    You are a research assistant. Answer the question. Use web_search when
    you need current information, and calculator for arithmetic.

    The question: {{inputs.question}}

  tools: [web_search, calculator]
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
  files: [],
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
  flow: `weave: 1
name: shell

inputs:
  task: string

# Declaring the inputs is what gives the model a shape to fill in: they
# become the function's parameters, and a tool with none is a tool it can
# only call empty.
tools:
  bash:
    description: >-
      Run a shell command and return its stdout, stderr and exit code.
      Runs in $HEDDLE_WORKSPACE. python3 and node are on PATH. Each call
      is a fresh shell and commands are killed after 20 seconds.
    inputs:
      command: string
    outputs:
      stdout: string
      stderr: string
      exit_code: integer

agent:
  # No api_key and no url, so the engine supplies the free model it was
  # configured with -- see the agent example for why that pair is
  # all-or-nothing.
  model:
    provider: openai
    model: openrouter/free

  prompt: |
    You run shell commands to answer the task. python3 and node are both on
    PATH; use whichever suits the work.

    Each call is a fresh shell, so cd and exported variables do not survive
    to the next one -- chain what depends on itself into a single command.
    Read exit_code every time: a zero exit is the only evidence a command
    did what you meant. Nothing interactive works, and a command is killed
    after 20 seconds.

    Answer in one or two sentences, saying what you ran and what came back.

    The task: {{inputs.task}}

  tools: [bash]
`,
  inputs: `{
  "task": "count the vowels in \\"weave agents from spec\\" with python, then reverse the string with node"
}
`,
  tools: [BASH_TOOL],
  plugins: [],
  files: [],
};

/* An encoder renders the run for the caller who asked and cannot alter it, so
   unlike a middleware it may be submitted with the request — which is the only
   way anything reaches the deployed engine, since its flags live in a systemd
   unit rather than in this repository.

   The plugin below is `examples/ag-ui/encoder.mjs` and `examples/ag-ui/encoder.json`
   verbatim: the same pair the CLI runs and the server's own tests assert on,
   rather than a second encoder written for the browser. The manifest is named
   after its entry point because that is how heddle finds it. */
const AG_UI: Example = {
  id: "ag-ui",
  title: "A run rendered as AG-UI",
  blurb:
    "An encoder plugin renders this run as AG-UI. The protocol beside the run chooses which vocabulary the frames arrive in.",
  protocol: "ag-ui",
  flow: `weave: 1
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
  # No api_key and no url, so the engine supplies the free model it was
  # configured with -- see the agent example for why that pair is
  # all-or-nothing.
  model:
    provider: openai
    model: openrouter/free

  prompt: |
    Call digest for a hash rather than guessing one. Answer in one sentence.

    The question: {{inputs.question}}

  tools: [digest]
`,
  inputs: `{
  "question": "what is the sha-256 of: weave agents from spec"
}
`,
  tools: [
    {
      name: "digest",
      interpreter: "python3",
      source: `import hashlib, json, sys

args = json.load(sys.stdin)
text = args.get("text", "")

# Something the model cannot work out for itself, so the turn has to contain a
# real tool call -- which is the pair of frames worth looking at.
json.dump({"sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}, sys.stdout)
`,
    },
  ],
  plugins: [
    {
      name: "ag-ui",
      manifest: {
        name: "ag-ui-encoder",
        version: "1.0.0",
        capabilities: [],
        components: [
          {
            componentType: "AgUiEncoder",
            kind: "encoder",
            protocol: "ag-ui",
            contentType: "text/event-stream; charset=utf-8",
          },
        ],
      },
      source: `function createEncoder(runId) {
  let openMessage;
  let completed = false;
  let lastError;
  let visit = 0;
  let runState = {};

  const idFor = (event) => \`\${event.nodeName ?? 'run'}#\${visit}\`;

  const closeMessage = () => {
    if (openMessage === undefined) return [];
    const frames = [{ data: { type: 'TEXT_MESSAGE_END', messageId: openMessage } }];
    openMessage = undefined;
    return frames;
  };

  return {
    encode(event) {
      switch (event.type) {
        case 'flow_start':
          return [{ data: { type: 'RUN_STARTED', threadId: runId, runId } }];

        case 'node_start':
          visit++;
          runState = { ...runState, ...event.state };
          return [{ data: { type: 'STEP_STARTED', stepName: event.nodeName } }];

        case 'token_delta': {
          const id = idFor(event);
          const frames = [];
          if (openMessage !== id) {
            frames.push(...closeMessage());
            frames.push({
              data: { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
            });
            openMessage = id;
          }
          frames.push({
            data: { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta: event.delta },
          });
          return frames;
        }

        case 'tool_call':
          return [
            {
              data: {
                type: 'TOOL_CALL_START',
                toolCallId: event.toolCallId,
                toolCallName: event.toolName,
                parentMessageId: idFor(event),
              },
            },
            {
              data: {
                type: 'TOOL_CALL_ARGS',
                toolCallId: event.toolCallId,
                delta: JSON.stringify(event.toolArgs ?? {}),
              },
            },
            { data: { type: 'TOOL_CALL_END', toolCallId: event.toolCallId } },
          ];

        case 'tool_result':
          return [
            {
              data: {
                type: 'TOOL_CALL_RESULT',
                messageId: \`\${idFor(event)}:\${event.toolCallId}\`,
                toolCallId: event.toolCallId,
                content: event.error
                  ? \`Error: \${event.error.message}\`
                  : typeof event.toolResult === 'string'
                    ? event.toolResult
                    : JSON.stringify(event.toolResult ?? null),
                role: 'tool',
              },
            },
          ];

        case 'node_complete': {
          const frames = closeMessage();
          frames.push({ data: { type: 'STEP_FINISHED', stepName: event.nodeName } });
          if (event.state) {
            runState = { ...runState, ...event.state };
            frames.push({ data: { type: 'STATE_SNAPSHOT', snapshot: runState } });
          }
          return frames;
        }

        case 'node_error': {
          lastError = event.error?.message ?? 'a node failed';
          const frames = closeMessage();
          frames.push({ data: { type: 'STEP_FINISHED', stepName: event.nodeName } });
          return frames;
        }

        case 'flow_complete':
          completed = true;
          return closeMessage();

        case 'warning':
        case 'plugin_log':
          return [
            {
              data: {
                type: 'CUSTOM',
                name: event.type,
                value: { message: event.message, level: event.level, node: event.nodeName },
              },
            },
          ];

        default:
          return [];
      }
    },

    finish() {
      const frames = closeMessage();
      frames.push(
        completed
          ? { data: { type: 'RUN_FINISHED', threadId: runId, runId } }
          : {
              data: {
                type: 'RUN_ERROR',
                message: lastError ?? 'the run ended without completing',
                code: 'HEDDLE_RUN_INCOMPLETE',
              },
            },
      );
      return frames;
    },
  };
}

const encoders = new Map();
const encoderFor = (ctx) => {
  let encoder = encoders.get(ctx.runId);
  if (!encoder) {
    encoder = createEncoder(ctx.runId);
    encoders.set(ctx.runId, encoder);
  }
  return encoder;
};

serve({
  AgUiEncoder: {
    encode: (event, ctx) => encoderFor(ctx).encode(event),
    finish: (ctx) => {
      const encoder = encoderFor(ctx);
      encoders.delete(ctx.runId);
      return encoder.finish();
    },
  },
});
`,
    },
  ],
  files: [],
};

/* A skill is a folder of instructions on a disk, and the run has one: the
   engine copies whatever the request sent into every node's workspace before
   the flow starts, so the three files below are on disk by the time a tool
   looks for them. Nothing is installed on the engine to make that true, and
   nothing survives the run.

   Which leaves the part that is not about disks at all. The skills reach the
   model as two tools rather than as prompt text, because names and descriptions
   are cheap and always in context while a body is a tool call the model decided
   to make, on a task it decided the skill covers. Paste twenty skills into the
   system prompt instead and you have not built skills, you have built a long
   prompt. */
const SKILL_FILES: RequestFile[] = [
  {
    path: "skills/tabular-summary.md",
    content: `Total, average or rank rows of data -- a CSV, a TSV, a pasted table. Read this before doing arithmetic over more than a couple of rows.

Do not add the rows up yourself. Put them in a file and let a script do it.

1. write_file the rows verbatim to data.csv. Do not retype a figure, reorder a
   column, or drop the header.
2. write_file a summarise.py that reads data.csv with the csv module and prints
   one line per figure you were asked for.
3. bash: python3 summarise.py
4. Report only numbers that appeared in its output.

If exit_code is not 0, fix the script and run it again. Never fall back to
working the answer out in your head -- that is the mistake this procedure exists
to prevent.

Round money in the script, to two places, rather than in the sentence you write.
`,
  },
  {
    path: "skills/date-arithmetic.md",
    content: `Days between two dates, a weekday, or a date some interval away. Read this before stating any date you did not copy from the input.

Counting days by hand goes wrong at month ends and in February. Run it.

  bash: python3 -c "from datetime import date, timedelta; print((date(2026,3,1) - date(2025,11,14)).days)"

A weekday is print(date(2026,3,1).strftime('%A')). A date n days on is
print(date(2026,3,1) + timedelta(days=n)).

Quote the number the command printed. If a date arrives without a year, say
which year you took it to be instead of choosing one silently.
`,
  },
  {
    path: "skills/incident-note.md",
    content: `The house format for writing up something that broke -- an outage, a failed job, a bad deploy. Read this before writing any incident summary.

Five lines, this order, one sentence each. No headings, no adjectives, no names.

WHAT:  the behaviour somebody outside would have noticed.
WHEN:  the window in UTC, and how long it lasted.
FOUND: what noticed it -- an alarm, a customer, somebody looking.
CAUSE: the change or condition that produced it.
GUARD: the check that would have caught it before a user did.

Write "not established" for CAUSE when it is not established. A plausible cause
stated as a settled one is the failure this format exists to prevent.
`,
  },
];

/* The first line of a skill is its description: when it applies, in one
   sentence. That line is what the model carries all the time, and everything
   under it is what a second tool call costs. Sending the bodies from here would
   put every skill in the conversation on the first call, which is the whole
   thing this arrangement avoids. */
const LIST_SKILLS_TOOL: RequestTool = {
  name: "list_skills",
  interpreter: "python3",
  source: `import json, os, pathlib, sys

json.load(sys.stdin)

# The workspace, not the working directory -- they are the same today, and
# saying which one is meant survives a tool being called from somewhere else.
root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"

index = "\\n".join(
    "%s: %s" % (path.stem, path.read_text().splitlines()[0])
    for path in sorted(root.glob("*.md"))
)

json.dump({"skills": index or "there are no skills here"}, sys.stdout)
`,
};

const READ_SKILL_TOOL: RequestTool = {
  name: "read_skill",
  interpreter: "python3",
  source: `import json, os, pathlib, sys

data = json.load(sys.stdin)
asked = str(data.get("name") or "").strip().lower()

root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"
path = root / ("%s.md" % asked)

# Refused rather than trusted: the name arrives from the model, and "../../etc"
# is a path this would otherwise open.
inside = asked and path.parent.resolve() == root.resolve()

if inside and path.is_file():
    body = path.read_text()
else:
    # Answered, not thrown. A tool that fails takes the round with it, and the
    # model that mistyped the name is the one reader who can correct it.
    names = ", ".join(sorted(p.stem for p in root.glob("*.md")))
    body = 'there is no skill called "%s". There are: %s.' % (asked, names)

json.dump({"body": body}, sys.stdout)
`,
};

/* Every path is taken relative to $HEDDLE_WORKSPACE, and refused if it climbs
   out. Here the sandbox has already made that true and this is belt and braces.
   Run the same tool locally under heddle run without --safe and the variable is
   still set -- a workspace is opened on every run -- but nothing is enforcing
   its edges, so the refusal below is the only thing keeping a written path
   inside it. */
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
  flow: `weave: 1
name: skills

inputs:
  task: string

# All five tools are submitted scripts with no manifest behind them, so each
# declares its own shape here. The first two are the whole of the skills
# mechanism: one lists what is in skills/, the other reads one file out of it.
# Neither knows anything about skills that the directory does not tell it.
tools:
  list_skills:
    description: >-
      List every skill: its name and one line on when it applies. Call this
      first.
    outputs:
      skills: string

  read_skill:
    description: >-
      Return the full text of one skill, by the name list_skills gave.
    inputs:
      name: string
    outputs:
      body: string

  # write_file and bash together are a shell: whatever the model can write it
  # can then run. Here that is a throwaway workspace the sandbox deletes when
  # the agent finishes. Where it would not be, the gate is the toolCall seam --
  # examples/policies/ ships an ApprovalGate that reads the arguments the model
  # chose and refuses the call before it is made.
  write_file:
    description: >-
      Write a file in the workspace. The path is relative to it, and a path
      that climbs out is refused.
    inputs:
      path: string
      content: string
    outputs:
      result: string

  read_file:
    description: Read a file from the workspace, by a path relative to it.
    inputs:
      path: string
    outputs:
      content: string

  bash:
    description: >-
      Run a shell command in the workspace and return its stdout, stderr and
      exit code. Each call is a fresh shell and commands are killed after 20
      seconds.
    inputs:
      command: string
    outputs:
      stdout: string
      stderr: string
      exit_code: integer

agent:
  # No api_key and no url, so the engine supplies the free model it was
  # configured with -- see the agent example for why that pair is
  # all-or-nothing.
  model:
    provider: openai
    model: openrouter/free

  # The contract, and the only place it is stated. A model that is not told
  # to look will not look, and a skill nobody reads is a file.
  prompt: |
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

    The task: {{inputs.task}}

  tools: [list_skills, read_skill, write_file, read_file, bash]
`,
  inputs: `{
  "task": "Total these expenses by category and say which category cost the most.\\n\\ndate,category,amount\\n2026-03-02,travel,412.50\\n2026-03-04,meals,38.20\\n2026-03-09,travel,96.00\\n2026-03-11,software,240.00\\n2026-03-18,meals,52.75"
}
`,
  tools: [
    LIST_SKILLS_TOOL,
    READ_SKILL_TOOL,
    WRITE_FILE_TOOL,
    READ_FILE_TOOL,
    BASH_TOOL,
  ],
  plugins: [],
  files: SKILL_FILES,
};

export const EXAMPLES: Example[] = [
  TOOL_AND_PLUGIN,
  GUARDRAIL,
  BRANCHING,
  AGENT,
  RESEARCH,
  SHELL,
  SKILLS,
  AG_UI,
];

export const DEFAULT_EXAMPLE = EXAMPLES[0];

/** The example an id names, for the comparison's handover to the editor. */
export function exampleById(id: string): Example | undefined {
  return EXAMPLES.find((example) => example.id === id);
}

export const INTERPRETERS = ["sh", "bash", "python3", "node"] as const;
