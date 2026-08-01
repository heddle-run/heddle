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

/* Two audiences arrive wanting different first commands, and the difference is
   not cosmetic: a person wants to run a flow, an agent wants to be taught how to
   write one. npx leads the human tab because it is the claim rather than an
   option — the runtime stays outside the project. `npm install -g` and Homebrew
   are in the docs; a landing page owes each visitor one command, not four.

   Every command here is a run, not an install. That is the point. */
export const installTabs = [
  {
    id: "humans",
    label: "Humans",
    note: "Point it at a document. Nothing enters your project.",
    commands: [
      { label: "npx", cmd: "npx @heddle/cli run flow.json" },
      { label: "docker", cmd: "docker run --rm salahpichen/heddle --help" },
    ],
  },
  {
    id: "agents",
    label: "Agents",
    note: "Teaches your coding agent to write, validate and run a heddle agent.",
    commands: [{ label: "skill", cmd: "npx skills add heddle-run/heddle" }],
  },
];

export const definition = {
  word: "heddle",
  pronunciation: "| ˈhɛd(ə)l |",
  partOfSpeech: "noun",
  body: "The part of a loom that lifts individual warp threads to form the shed — the opening through which the weft passes. It decides, thread by thread, what the pattern becomes.",
};

/* The inventory that makes "batteries included" a countable claim rather than
   an adjective. Every line here is a feature heddle actually ships — check it
   against the README before adding one, the same way safeMode is checked
   against packages/core/src/sandbox/. */
export const manifest = [
  {
    icon: "bot",
    title: "Tool-calling loop",
    detail: "Up to ten rounds per agent, every call traced.",
  },
  {
    icon: "circle-check-big",
    title: "Pre-flight validation",
    detail: "Spec, graph and reachability checked before a token is spent.",
  },
  {
    icon: "shield",
    title: "OS-level sandbox",
    detail: "bubblewrap on Linux, seatbelt on macOS, under --safe.",
  },
  {
    icon: "network",
    title: "HTTP server",
    detail: "heddle-server streams execution events over SSE.",
  },
  {
    icon: "list-checks",
    title: "Guardrails",
    detail: "Pre- and post-model transforms; a rejected prompt costs nothing.",
  },
  {
    icon: "repeat",
    title: "Policies",
    detail: "Retry, approval gates and rate limits, installed at the seams.",
  },
  {
    icon: "git-branch",
    title: "Branching",
    detail: "Conditional routing, checked for reachability before it runs.",
  },
  {
    icon: "terminal",
    title: "Any-language tools",
    detail: "A JSON-speaking executable. Bash, Python, Go, Node.",
  },
  {
    icon: "shuffle",
    title: "Provider swap",
    detail: "OpenAI, vLLM, Ollama, or any OpenAI-compatible endpoint.",
  },
  {
    icon: "message-square",
    title: "Interactive chat",
    detail: "--session keeps the conversation, on disk or in your own store.",
  },
  {
    icon: "webhook",
    title: "Protocol encoders",
    detail: "Render the server's event stream as AG-UI, chosen per request.",
  },
  {
    icon: "package",
    title: "Scaffolding",
    detail: "heddle init writes a flow and a working tool to run.",
  },
  {
    icon: "layers",
    title: "Per-agent workspace",
    detail: "One directory an agent's tools share; --mount seeds it.",
  },
];

/* The other half of the claim: what the batteries cost you. Everything a
   library would have added to the project, at zero. */
export const notInProject = [
  { value: "0", label: "Packages in your lockfile" },
  { value: "0", label: "Classes to subclass" },
  { value: "0", label: "Lines of glue code" },
  { value: "0", label: "Accounts or gateways" },
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

/* The manifest lists what is included; this goes deep on the handful that are
   hard to copy. Every other batteries-included runtime is a library, so its
   batteries arrive as dependencies — that difference leads. */
export const features = [
  {
    icon: "package",
    hue: "var(--brand-pink)",
    title: "The batteries stay outside your codebase",
    description:
      "Included usually means installed. A framework that ships a sandbox, a server and a retry policy ships them into your project, and every one becomes an import, a version to pin and an abstraction to work around. heddle is a runtime, not a library: the same equipment sits behind a binary you point at a document. Nothing enters your lockfile, so nothing has to be migrated when the framework changes its mind.",
  },
  {
    icon: "circle-check-big",
    hue: "var(--hue-purple)",
    title: "Checked before it costs anything",
    description:
      "Parse, validate, compile, validate again — the whole graph is proved reachable and well-formed before the first request leaves your machine. A malformed flow fails in milliseconds, not halfway through a paid run.",
  },
  {
    icon: "shield",
    hue: "var(--hue-blue)",
    title: "A boundary the kernel enforces",
    description:
      "Every agent gets a workspace: one directory its tools share, so they can hand each other files. --safe makes its edges a kernel boundary — no $HOME, nothing writable outside it, and only the environment variables you name. Ask for a backend the machine cannot provide and the run fails rather than quietly continuing unconfined.",
  },
  {
    icon: "network",
    hue: "var(--hue-emerald)",
    title: "One document, two runtimes",
    description:
      "heddle run on your machine and heddle-server over HTTP are the same engine reading the same file. Moving from a laptop to a service is a deployment, not a rewrite.",
  },
  {
    icon: "git-branch",
    hue: "var(--hue-amber)",
    title: "Portable off heddle",
    description:
      "The document is an Open Agent Specification flow — a format published by Oracle, not invented here. A flow written for heddle runs on any other conforming runtime, which makes leaving cheap and staying a choice.",
  },
  {
    icon: "blocks",
    hue: "var(--hue-rose)",
    title: "Extended without a fork",
    description:
      "Plugins add component types, transforms, wire-protocol encoders and run middleware from outside the engine. They are named on the command line, never inside a flow, so sharing a spec can never execute code.",
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
        "A tool subprocess gets no $HOME, sees only the environment variables --allow-env names, and can write nowhere but its own workspace. bubblewrap on Linux, seatbelt on macOS.",
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
      "A batteries-included declarative agent runtime. You declare a multi-step flow in YAML or JSON using the Open Agent Specification, and heddle parses it, validates it, compiles it into an executable graph, and runs it — from the CLI on your machine, or behind an HTTP server. The tool-calling loop, the sandbox, the guardrails, the retry policies and the event stream come with it.",
  },
  {
    question: "What does batteries-included actually mean here?",
    answer:
      "That the equipment an agent needs in production is already in the runtime rather than left to you: a tool-calling loop, pre-flight graph validation, an OS-level sandbox, a per-agent workspace, an HTTP server with event streaming, guardrail transforms, retry and approval policies, branching, chat sessions, wire-protocol encoders and project scaffolding. The manifest on this page lists them, and each one is a feature you can check against the README rather than a claim about quality.",
  },
  {
    question: "How is this different from other agent frameworks?",
    answer:
      "Frameworks like LangGraph, CrewAI and Mastra are libraries: you install them, import them, and assemble the graph in Python or TypeScript, so your agent is code that depends on their abstractions. When one of them says batteries-included, the batteries arrive as dependencies. heddle inverts that. The flow is a document you write, and heddle is a runtime you point at it. Nothing enters your dependency tree, no class needs subclassing, and because the document conforms to a published specification rather than to this project, the same flow runs on any other compliant runtime.",
  },
  {
    question: "How is this different from other declarative agent runtimes?",
    answer:
      "Declarative agents in YAML are no longer unusual — Docker Agent, Microsoft's declarative workflows and Google's ADK all offer a version of it, and that is a good thing for everyone writing agents. Two things separate heddle. The format is the Open Agent Specification, published by Oracle rather than defined by this project, so a flow is portable to any conforming runtime instead of to one vendor's product. And the sandbox is a kernel boundary on your own machine — bubblewrap or seatbelt — rather than a container or a hosted execution service, with a documented refusal to degrade into an unconfined run.",
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
    question: "Where do tools write, and how do they pass files to each other?",
    answer:
      "Each agent execution gets a workspace: one directory its tools share, and the working directory each of them starts in. Write a CSV in one call and run a script over it in the next; a different agent in the same flow sees an empty one, and it is removed when the agent finishes. Tools are also reachable by name from inside it, so a tool can run a peer. To put your own files there before the run starts, use --mount — read-only by default, or :rw to have what the run changed copied back out. --workspace keeps each workspace on disk afterwards instead of discarding it.",
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
