import {
  FileJson,
  GitBranch,
  Bot,
  Terminal,
  Shuffle,
  MessageSquare,
} from "lucide-react";

export const SITE_URL = "https://heddle.run";
export const GITHUB_URL = "https://github.com/spichen/heddle";
export const NPM_URL = "https://www.npmjs.com/package/@heddle/cli";
export const AGENT_SPEC_URL = "https://oracle.github.io/agent-spec/";
export const VERSION = "0.1.0-beta6";

export const installCommands = [
  { label: "npm", cmd: "npm install -g @heddle/cli" },
  { label: "brew", cmd: "brew install spichen/tap/heddle" },
];

/** Dictionary epigraph — the name is the product thesis. */
export const definition = {
  word: "heddle",
  pronunciation: "| ˈhɛd(ə)l |",
  partOfSpeech: "noun",
  body: "The part of a loom that lifts individual warp threads to form the shed — the opening through which the weft passes. It decides, thread by thread, what the pattern becomes.",
};

export const stats = [
  { value: "6", label: "Node types" },
  { value: "4", label: "LLM providers" },
  { value: "0", label: "Servers to run" },
  { value: "1", label: "Command" },
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
      "Parse, validate, compile, execute. One command, on your machine, with the whole graph checked before a single token is spent.",
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
    icon: FileJson,
    title: "Declarative flows",
    description:
      "Multi-step agent workflows in YAML or JSON. The spec is the program; there is no boilerplate to maintain alongside it.",
  },
  {
    icon: GitBranch,
    title: "Graph execution",
    description:
      "Flows compile into a directed graph of control-flow and data-flow edges, validated for reachability before anything runs.",
  },
  {
    icon: Bot,
    title: "Tool-calling loop",
    description:
      "Agent nodes call tools autonomously until the task is finished — up to ten rounds per node, with every call traced.",
  },
  {
    icon: Terminal,
    title: "Any-language tools",
    description:
      "A tool is a subprocess that speaks JSON over stdin and stdout. If it runs on your machine, it works here.",
  },
  {
    icon: Shuffle,
    title: "Provider agnostic",
    description:
      "OpenAI, vLLM, Ollama, or any OpenAI-compatible endpoint. Swap the model without touching the flow.",
  },
  {
    icon: MessageSquare,
    title: "Interactive chat",
    description:
      "Hold a persistent multi-turn conversation with a flow through --chat, and read the transcript back from disk.",
  },
];

export const specimens = [
  {
    index: "I",
    title: "Research Assistant",
    category: "Flow",
    description: "An agent with web search and a calculator",
    code: `component_type: AgentNode
name: researcher
agent:
  component_type: Agent
  name: research-agent
  system_prompt: Research the user's question.
  llm_config:
    component_type: OpenAiConfig
    name: openai
    model_id: gpt-4o
  tools:
    - { component_type: ServerTool, name: web_search }
    - { component_type: ServerTool, name: calculator }`,
  },
  {
    index: "II",
    title: "Math Homework",
    category: "Agent",
    description: "A multiplication tool served by vLLM",
    code: `component_type: Agent
name: math-helper
system_prompt: Solve the multiplication problem.
llm_config:
  component_type: VllmConfig
  name: llama
  model_id: meta-llama/Llama-3.1-8B
  url: http://localhost:8000/v1
tools:
  - component_type: ServerTool
    name: multiplication_tool
    inputs:
      - { title: a, type: integer }
      - { title: b, type: integer }`,
  },
  {
    index: "III",
    title: "Retrieval Expert",
    category: "Agent",
    description: "A domain expert grounded in your corpus",
    code: `component_type: Agent
name: rag-expert
system_prompt: |
  You are an expert in
  {{domain_of_expertise}}.
llm_config:
  component_type: OpenAiConfig
  name: openai
  model_id: gpt-4o
tools:
  - component_type: ServerTool
    name: rag_tool
    inputs:
      - title: query
        type: string`,
  },
  {
    index: "IV",
    title: "IT Assistant",
    category: "Agent",
    description: "Enterprise support on a local model",
    code: `component_type: Agent
name: it-assistant
system_prompt: |
  You are an IT assistant.
  Help users troubleshoot.
llm_config:
  component_type: VllmConfig
  name: llama
  model_id: meta-llama/Llama-3.1-8B
  url: http://vllm:8000/v1`,
  },
];

/** The spec / terminal spread. */
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
      "heddle is a lightweight CLI runtime for agentic workflows. You declare a multi-step flow in YAML or JSON using the Open Agent Specification, and heddle parses it, validates it, compiles it into an executable graph, and runs it locally with a single command.",
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
