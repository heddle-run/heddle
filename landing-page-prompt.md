# Landing Page Design Prompt for Heddle

Use this prompt with a design generation tool (e.g., v0, Figma AI, or similar):

---

Design a modern, developer-focused landing page for **Heddle** — a lightweight CLI framework for building and running agentic AI workflows using the Open Agent Specification.

## Brand Identity

- **Name:** Heddle
- **Tagline:** "Define agents in YAML. Run them from the CLI."
- **Tone:** Technical but approachable. Clean, minimal, confident. Think Vercel/Stripe-level polish for a developer tool.
- **Color palette:** Dark background (near-black or deep navy) with a vibrant accent color (electric blue or green). Monospace typography for code elements, clean sans-serif for copy.

## Page Sections (top to bottom)

### 1. Hero Section
- Large headline: "Build Agentic AI Workflows Without Writing Orchestration Code"
- Subtitle: "Heddle is a lightweight CLI that compiles declarative agent specs into executable graphs — with LLM tool-calling, branching logic, and external tool support built in."
- Two CTAs: "Get Started" (primary) and "View on GitHub" (secondary/outlined)
- Animated or static terminal mockup showing:
  ```
  $ heddle init my-agent
  $ heddle run flow.yaml --input '{"query": "What is quantum computing?"}'
  ```
- Small badge: "Open Agent Specification compliant" and "v0.1.0-beta"

### 2. "How It Works" — 3-Step Visual
Show three steps with icons/illustrations and short code snippets:

**Step 1: Define** — "Describe your workflow in YAML or JSON using the Open Agent Specification."
Show a compact YAML snippet of a flow with a start node, an agent node with tools, and an end node.

**Step 2: Wire Tools** — "Tools are standalone executables. Write them in any language — Bash, Python, Go. No SDK required."
Show a simple bash tool that reads JSON from stdin and writes JSON to stdout.

**Step 3: Run** — "Compile, validate, and execute — all from one command."
Show terminal output with the agent calling tools and returning a result.

### 3. Key Features Grid (2x3 or 3x2)
Each feature gets an icon, title, and one-line description:

1. **Declarative Workflows** — Define multi-step agent flows in YAML/JSON. No boilerplate code.
2. **Graph-Based Execution** — Flows compile into directed graphs with control flow and data flow edges, validated before running.
3. **LLM Tool-Calling Loop** — Agents autonomously call tools in a loop until the task is done. Supports up to 10 rounds per node.
4. **Any-Language Tools** — Tools are subprocesses that speak JSON over stdin/stdout. Use Bash, Python, Node, Go — anything.
5. **Provider Agnostic** — Works with OpenAI, vLLM, Ollama, or any OpenAI-compatible endpoint. Swap models without changing your flow.
6. **Interactive Chat Mode** — Debug and explore flows with persistent multi-turn conversations via `--chat`.

### 4. Architecture Diagram
A clean, minimal flow diagram showing the execution pipeline:
```
YAML/JSON Spec → Parse → Validate → Compile Graph → Execute Runner → Output
                                        ↓
                              [StartNode → AgentNode (LLM + Tools) → BranchingNode → EndNode]
```
Use node-and-edge style visualization. Color-code node types (Agent = blue, Tool = green, Branching = orange, Start/End = gray).

### 5. Code Example — Full Workflow
Side-by-side layout:
- **Left:** A complete YAML agent spec for a "Research Assistant" flow (start → agent with web_search tool → end)
- **Right:** The terminal output showing execution — the agent receiving a query, calling the tool, and returning the answer

### 6. Feature Highlights (alternating left-right sections)

**Highlight 1: "Runs Locally. No Backend Required."**
Everything executes on your machine. Tools run as child processes. State flows immutably through the graph. No cloud service, no API gateway, no infrastructure to manage.

**Highlight 2: "Built on the Open Agent Specification"**
Heddle implements Oracle's Open Agent Specification — a portable, standardized format for defining agent workflows. Your specs work across any compliant runtime.

**Highlight 3: "From Zero to Agent in 30 Seconds"**
`heddle init` scaffolds a complete project with a sample flow, tools directory, and ready-to-run configuration.

### 7. Install / Quick Start
Dark terminal-style card:
```bash
# Install via npm
npm install -g @heddle/cli

# Or via Homebrew
brew install spichen/tap/heddle

# Create your first agent
heddle init my-agent
cd my-agent
heddle run flow.yaml --input '{"query": "Hello, world"}'
```

### 8. Open Source CTA / Footer
- "Heddle is open source and MIT licensed."
- GitHub stars badge, npm version badge
- Links: GitHub, Documentation, Examples, npm
- "Built by spichen"

## Design Guidelines

- Use generous whitespace and a clear visual hierarchy
- Code blocks should use a dark theme with syntax highlighting (e.g., One Dark or similar)
- Subtle grid lines or dot patterns in the background for a technical feel
- Smooth scroll animations for section reveals
- Responsive — mobile-first but optimized for developer screens (wide viewports)
- No stock photos. Use abstract geometric illustrations, terminal mockups, and code snippets as visual elements
- Consider a subtle animated gradient or particle effect in the hero background

## Tech Preferences (if generating code)
- Next.js / React with Tailwind CSS
- Framer Motion for animations
- Lucide icons or Heroicons
- Dark mode by default with optional light mode toggle
