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
export const DEFAULT_FLOW = `component_type: Flow
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

  # A plugin node. ReverseNode is not a heddle type — the plugin below adds it,
  # and the engine learns its shape from that plugin's manifest while parsing
  # this file, without running any of its code.
  reverse:
    component_type: ReverseNode
    id: reverse
    name: reverse

  end:
    component_type: EndNode
    id: end
    name: end
`;

export const DEFAULT_INPUTS = `{
  "text": "weave agents from spec"
}
`;

/**
 * A tool reads its input as JSON on stdin and writes JSON on stdout.
 *
 * Plain `sh` on purpose. A sandboxed tool gets a fixed PATH of the system
 * directories, so `python3` and `node` are only available where the engine's
 * image happens to put them — but `sh`, `sed` and `tr` are always there. The
 * starting example should run on any engine, not only the one we deploy.
 */
export const DEFAULT_TOOL: RequestTool = {
  name: "shout",
  interpreter: "sh",
  source: `read -r input

text=$(printf '%s' "$input" | sed -n 's/.*"text"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p')

printf '{"shouted":"%s"}' "$(printf '%s' "$text" | tr '[:lower:]' '[:upper:]')"
`,
};

/**
 * A plugin adds a component type the engine does not ship.
 *
 * Two halves. The manifest declares what the plugin provides, as data, so the
 * engine can parse a flow that uses `ReverseNode` without running anything.
 * The source only has to say what the node *does* — `serve()` is supplied by
 * the engine, so there is nothing to import and no build step.
 */
export const DEFAULT_PLUGIN: RequestPlugin = {
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

export const INTERPRETERS = ["sh", "bash", "python3", "node"] as const;
