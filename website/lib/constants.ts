export const SITE_URL = "https://heddle.run";

/* The playground — the editor, the run log and the framework comparison, one
   application — is exported at /playground and served at the root of
   playground.heddle.run. The same page either way; this is the address the
   site links to. It is set at build time because a local build, a preview
   deployment or a fork has no subdomain of its own, and unset the relative
   path is the correct one. */
const PLAYGROUND_ORIGIN = process.env.NEXT_PUBLIC_PLAYGROUND_URL?.replace(
  /\/+$/,
  "",
);

export const PLAYGROUND_URL = PLAYGROUND_ORIGIN || "/playground";

/** The same application, opened on the comparison rather than the editor. */
export const COMPARE_URL = `${PLAYGROUND_ORIGIN ? `${PLAYGROUND_ORIGIN}/` : "/playground"}?view=compare`;

/* Home, addressed from inside the playground. The wordmark in its bar is the
   way back to the site, and on the playground's own origin "/" is the
   playground itself — so there, home has to be spelled out. */
export const HOME_URL = PLAYGROUND_ORIGIN ? SITE_URL : "/";

export const GITHUB_URL = "https://github.com/spichen/heddle";
export const NPM_URL = "https://www.npmjs.com/package/@heddle/cli";
export const AGENT_SPEC_URL = "https://oracle.github.io/agent-spec/";
export const VERSION = "0.1.0-beta6";

export const installCommands = [
  { label: "npm", cmd: "npm install -g @heddle/cli" },
  { label: "brew", cmd: "brew install spichen/tap/heddle" },
  { label: "docker", cmd: "docker run --rm salahpichen/heddle --help" },
];

export const definition = {
  word: "heddle",
  pronunciation: "| ˈhɛd(ə)l |",
  partOfSpeech: "noun",
  body: "The part of a loom that lifts individual warp threads to form the shed — the opening through which the weft passes. It decides, thread by thread, what the pattern becomes.",
};

export const stats = [
  { value: "0", label: "SDKs to install" },
  { value: "0", label: "Lines of glue code" },
  { value: "2", label: "Ways to run a spec" },
  { value: "4", label: "LLM providers" },
];

export const steps = [
  {
    number: "01",
    title: "Declare",
    description:
      "Describe the flow in YAML or JSON using the Open Agent Specification. Nodes, control flow, data flow. Nothing else.",
    code: `# flow.yaml
component_type: Flow
name: research-flow
start_node:
  $component_ref: start
nodes:
  - $component_ref: start
  - $component_ref: agent
  - $component_ref: end
control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_agent
    from_node: { $component_ref: start }
    to_node: { $component_ref: agent }
  # ... agent -> end
$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - { title: query, type: string }
  # ... agent, end`,
  },
  {
    number: "02",
    title: "Wire",
    description:
      "Tools are ordinary executables. JSON in on stdin, JSON out on stdout. Bash, Python, Go — no SDK, no bindings.",
    code: `#!/usr/bin/env python3
import sys, json

args = json.load(sys.stdin)
query = args.get("query", "")

results = search(query)

json.dump({
  "results": results
}, sys.stdout)`,
  },
  {
    number: "03",
    title: "Run",
    description:
      "Parse, validate, compile, execute — with the whole graph checked before a single token is spent. One command locally, or the same spec behind heddle-server over HTTP.",
    code: `$ heddle run flow.yaml \\
    --tools-dir ./tools \\
    --input '{"query": "shed"}'

[researcher] ⚙ Web Search shed weaving
[researcher] ⚙ Web Search warp heddle

{
  "query": "shed",
  "result": "The shed is the..."
}`,
  },
];

export const features = [
  {
    icon: "file-json",
    hue: "var(--brand-pink)",
    title: "No SDK to install",
    description:
      "Every other framework starts with an import: a class to subclass, a decorator to remember, a graph to assemble in code. heddle starts with a document. Write the flow in YAML or JSON and hand it to the runtime — there is no library in your dependency tree, and nothing to migrate when the framework changes its mind.",
  },
  {
    icon: "git-branch",
    hue: "var(--hue-purple)",
    title: "Graph execution",
    description:
      "Flows compile into a directed graph of control-flow and data-flow edges, validated for reachability before anything runs.",
  },
  {
    icon: "bot",
    hue: "var(--hue-blue)",
    title: "Tool-calling loop",
    description:
      "Agent nodes call tools autonomously until the task is finished — up to ten rounds per node, with every call traced.",
  },
  {
    icon: "terminal",
    hue: "var(--hue-emerald)",
    title: "Any-language tools",
    description:
      "A tool is a subprocess that speaks JSON over stdin and stdout. If it runs on your machine, it works here.",
  },
  {
    icon: "shuffle",
    hue: "var(--hue-amber)",
    title: "Provider agnostic",
    description:
      "OpenAI, vLLM, Ollama, or any OpenAI-compatible endpoint. Swap the model without touching the flow.",
  },
  {
    icon: "network",
    hue: "var(--hue-rose)",
    title: "CLI or HTTP server",
    description:
      "The same spec runs two ways: heddle run on your machine, or heddle-server streaming events over HTTP. One engine, no rewrite between them.",
  },
];

export const safeMode = {
  flag: "--safe",
  points: [
    {
      icon: "shield",
      hue: "var(--brand-pink)",
      title: "Tools run confined",
      description:
        "A tool subprocess gets no $HOME, cannot write outside the run workspace, and sees only the environment variables --allow-env names. bubblewrap on Linux, seatbelt on macOS.",
    },
    {
      icon: "boxes",
      hue: "var(--hue-purple)",
      title: "Plugins run out of process",
      description:
        "A plugin never shares the runtime's heap, globals or environment. It speaks JSON-Lines over stdio from its own process, and is killed when the run ends.",
    },
    {
      icon: "file-code",
      hue: "var(--hue-blue)",
      title: "The spec is data, not code",
      description:
        "A flow is parsed, never evaluated. Where a spec arrives from a caller rather than from you, a $VAR reference into the host environment is refused rather than resolved — running your own spec locally, it still resolves.",
    },
    {
      icon: "circle-check-big",
      hue: "var(--hue-emerald)",
      title: "It never degrades quietly",
      description:
        "Ask for a sandbox backend that is not available and the run fails. There is no path on which --safe silently falls back to an unconfined process.",
    },
  ],
};

export const specimenSpread = {
  spec: `component_type: Flow
name: research-assistant
start_node:
  $component_ref: start
nodes:
  - $component_ref: start
  - $component_ref: researcher
  - $component_ref: end
control_flow_connections:
  - component_type: ControlFlowEdge
    name: start_to_researcher
    from_node: { $component_ref: start }
    to_node: { $component_ref: researcher }
  # ... researcher -> end
$referenced_components:
  start:
    component_type: StartNode
    id: start
    name: start
    outputs:
      - { title: query, type: string }
  researcher:
    component_type: AgentNode
    id: researcher
    name: researcher
    agent:
      component_type: Agent
      name: research-agent
      system_prompt: |
        Answer the question. Use
        web_search when you need
        current information.
      llm_config:
        component_type: OpenAiConfig
        name: openai
        model_id: gpt-4o
      tools:
        - { component_type: ServerTool, name: web_search }
  # ... end`,
  terminal: [
    { kind: "prompt", text: "heddle run flow.yaml --tools-dir ./tools \\" },
    { kind: "cont", text: "  --input '{\"query\": \"what is a shed?\"}'" },
    { kind: "blank", text: "" },
    { kind: "muted", text: "  spec      valid" },
    { kind: "muted", text: "  graph     3 nodes, 2 edges, reachable" },
    { kind: "blank", text: "" },
    { kind: "tool", text: "[researcher] ⚙ Web Search shed weaving" },
    { kind: "tool", text: "[researcher] ⚙ Web Search warp heddle" },
    { kind: "blank", text: "" },
    { kind: "out", text: "{" },
    { kind: "out", text: '  "query": "what is a shed?",' },
    {
      kind: "out",
      text: '  "result": "The shed is the triangular opening',
    },
    { kind: "out", text: '    formed when heddles raise warp threads."' },
    { kind: "out", text: "}" },
  ],
};

export const faqItems = [
  {
    question: "What is heddle?",
    answer:
      "heddle is a lightweight runtime for agentic workflows. You declare a multi-step flow in YAML or JSON using the Open Agent Specification, and heddle parses it, validates it, compiles it into an executable graph, and runs it — from the CLI on your machine, or behind an HTTP server.",
  },
  {
    question: "How is this different from other agent frameworks?",
    answer:
      "There is no SDK. Frameworks like LangGraph, CrewAI and AutoGen are libraries: you install them, import them, and assemble the graph in Python or TypeScript, so your agent is code that depends on their abstractions. heddle inverts that. The flow is a document you write, and heddle is a runtime you point at it. Nothing enters your dependency tree, no class needs subclassing, and because the document conforms to a published specification rather than to this project, the same flow runs on any other compliant runtime.",
  },
  {
    question: "Can I run it as a service?",
    answer:
      "Yes. heddle-server exposes the same engine over HTTP and streams execution events as the run happens — it is what the playground on this site talks to. It binds to 127.0.0.1 by default and ships no authentication of its own, so put an authenticating proxy in front of it before exposing it to anything you do not control.",
  },
  {
    question: "What stops a tool from doing whatever it likes?",
    answer:
      "Run with --safe. Tool scripts are then executed inside a kernel-level sandbox — bubblewrap on Linux, seatbelt on macOS — with no $HOME, no writes outside the run workspace, and an environment cut down to the variables you name with --allow-env. Plugins are confined differently, by construction: they run in their own process and never see the runtime's memory or environment. If you ask for a sandbox backend the machine cannot provide, the run fails rather than quietly continuing unconfined.",
  },
  {
    question: "What is the Open Agent Specification?",
    answer:
      "A portable, standardised format for defining agent workflows, published by Oracle. heddle implements it, which means the flows you write here are not locked to this runtime — they run on any compliant one.",
  },
  {
    question: "Which LLM providers are supported?",
    answer:
      "OpenAI, vLLM, Ollama, and any OpenAI-compatible endpoint, out of the box. Changing provider is a few lines in the spec; the flow itself does not change.",
  },
  {
    question: "How do I write a tool?",
    answer:
      "Write an executable that reads a JSON object from stdin and writes a JSON object to stdout. Bash, Python, Go, Node — anything. Mark it executable, drop it in your tools directory, and reference it by name from the spec.",
  },
  {
    question: "Is heddle free?",
    answer:
      "Yes. heddle is open source under the MIT licence, and free to use in personal and commercial work alike.",
  },
  {
    question: "Does it work offline?",
    answer:
      "heddle itself runs entirely on your machine — no backend, no gateway, no account. If your flow calls a hosted model you will need a connection for those requests; point it at Ollama or vLLM and the whole thing runs offline.",
  },
];
