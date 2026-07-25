import {
  FileJson,
  GitBranch,
  Bot,
  Terminal,
  Shuffle,
  MessageSquare,
} from "lucide-react";

export const GITHUB_URL = "https://github.com/spichen/specrun";
export const NPM_URL = "https://www.npmjs.com/package/@heddle/cli";

export const showcaseItems = [
  {
    title: "Research Assistant",
    category: "Flow",
    description: "Agent with web search and calculator tools",
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
    title: "Math Homework Agent",
    category: "Agent",
    description: "Multiplication tool powered by vLLM",
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
    title: "RAG Agent",
    category: "Agent",
    description: "Domain expert with retrieval-augmented generation",
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
    title: "IT Assistant",
    category: "Agent",
    description: "Enterprise IT support with local LLM",
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

export const steps = [
  {
    number: "01",
    title: "Define",
    description:
      "Describe your workflow in YAML or JSON using the Open Agent Specification.",
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
    title: "Wire Tools",
    description:
      "Tools are standalone executables. Write them in any language — no SDK required.",
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
      "Compile, validate, and execute — all from one command.",
    code: `$ heddle run flow.yaml \\
    --tools-dir ./tools \\
    --input '{"query": "quantum computing"}'

[researcher] ⚙ Web Search quantum computing
[researcher] ⚙ Web Search quantum algorithms

{
  "query": "quantum computing",
  "result": "Quantum computing uses..."
}`,
  },
];

export const features = [
  {
    icon: FileJson,
    title: "Declarative Workflows",
    description:
      "Define multi-step agent flows in YAML/JSON. No boilerplate code.",
  },
  {
    icon: GitBranch,
    title: "Graph-Based Execution",
    description:
      "Flows compile into directed graphs with control and data flow edges, validated before running.",
  },
  {
    icon: Bot,
    title: "LLM Tool-Calling Loop",
    description:
      "Agents autonomously call tools in a loop until the task is done. Up to 10 rounds per node.",
  },
  {
    icon: Terminal,
    title: "Any-Language Tools",
    description:
      "Tools are subprocesses that speak JSON over stdin/stdout. Use Bash, Python, Go — anything.",
  },
  {
    icon: Shuffle,
    title: "Provider Agnostic",
    description:
      "Works with OpenAI, vLLM, Ollama, or any OpenAI-compatible endpoint.",
  },
  {
    icon: MessageSquare,
    title: "Interactive Chat Mode",
    description:
      "Debug and explore flows with persistent multi-turn conversations via --chat.",
  },
];

export const faqItems = [
  {
    question: "What is Heddle?",
    answer:
      "Heddle is a lightweight CLI framework for building and executing agentic AI workflows. It lets you define multi-step agent workflows in YAML or JSON using the Open Agent Specification, then compiles and runs them locally with a single command.",
  },
  {
    question: "What is the Open Agent Specification?",
    answer:
      "The Open Agent Specification is a portable, standardized format created by Oracle for defining agent workflows. Heddle implements this spec, meaning your workflow definitions are portable across any compliant runtime.",
  },
  {
    question: "What LLM providers are supported?",
    answer:
      "Heddle supports OpenAI, vLLM, Ollama, and any OpenAI-compatible endpoint out of the box. You can swap providers by changing a few lines in your spec — no code changes needed.",
  },
  {
    question: "How do I create custom tools?",
    answer:
      "Tools are standalone executables that read JSON from stdin and write JSON to stdout. Write them in any language — Bash, Python, Go, Node.js — no SDK required. Just make them executable and place them in your tools directory.",
  },
  {
    question: "Is Heddle free?",
    answer:
      "Yes. Heddle is fully open source under the MIT license. You can use it freely in personal and commercial projects.",
  },
  {
    question: "Does it work offline?",
    answer:
      "Heddle itself runs entirely locally with no backend or cloud service required. However, if your workflow uses a cloud LLM provider like OpenAI, you'll need internet access for those API calls. With a local provider like Ollama or vLLM, everything runs offline.",
  },
];
