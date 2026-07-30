import type { Framework } from "./types";

/* Every spec here has been checked with `heddle validate`, and the guardrail
   and routing flows have been run end to end — neither needs a credential,
   because a pre-transform that rejects skips the model call, and routing has
   no model in it at all. */

const RESEARCH_FLOW = `component_type: Flow
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

      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: openai
        model_id: gpt-4o
        api_key: $OPENAI_API_KEY

      # Declaring a tool's inputs is what gives the model a shape to fill
      # in: they become the function's parameters.
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

const GUARDRAIL_FLOW = `component_type: Flow
name: guarded-assistant
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

      # Never reached while the guardrail rejects. That is the point: a
      # blocked prompt costs nothing.
      llm_config:
        component_type: OpenAiConfig
        id: llm
        name: openai
        model_id: gpt-4o
        api_key: $OPENAI_API_KEY

      tools: []

      # Transforms travel with the agent, not with the graph, so this
      # guardrail applies in chat mode and to a standalone agent too.
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
        const { patterns = [], reason } = node.config ?? {};

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

const ROUTING_FLOW = `component_type: Flow
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
      description: Pages whoever is on call

  normal:
    component_type: ToolNode
    id: normal
    name: normal
    tool:
      component_type: ServerTool
      id: normal_tool
      name: file_ticket
      description: Files an ordinary ticket

  end:
    component_type: EndNode
    id: end
    name: end
`;

const CLASSIFY = `#!/usr/bin/env bash
read -r input

if printf '%s' "$input" | grep -qiE 'fire|outage|down|urgent'; then
  printf '{"branching_mapping_key":"urgent"}'
else
  printf '{"branching_mapping_key":"normal"}'
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

export const heddle: Framework = {
  id: "heddle",
  name: "heddle",
  install: "npm install -g @heddle/cli",
  packages: [],
  artifact: "a document",
  modelSwap: "Change model_id, or swap OpenAiConfig for another config type.",
  docs: "/docs",
  note:
    "The flow is data, not code. heddle parses it, validates the whole graph, " +
    "and runs it — nothing enters your dependency tree, and because the " +
    "document is Open Agent Specification rather than heddle's own format, it " +
    "runs on any compliant runtime.",

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
        "Agent Spec already defines the slot — Agent.transforms — so the " +
        "guardrail is configuration. A plugin supplies the one component type " +
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
        "The branch is an edge in the document, not an if-statement. Every " +
        "tool is its own executable, which is why this column has four files " +
        "where the others have one.",
    },
  },
};
