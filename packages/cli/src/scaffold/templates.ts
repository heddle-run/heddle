import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createStartNode,
  createEndNode,
  createAgentNode,
  createAgent,
  createOpenAiConfig,
  createServerTool,
  stringProperty,
  FlowBuilder,
  AgentSpecSerializer,
} from 'agentspec';

const toolTemplate = `#!/usr/bin/env bash
# Example tool: reads JSON from stdin, writes JSON to stdout
set -euo pipefail

# Parse input
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','no message'))" 2>/dev/null || echo "no message")

# Return JSON output
echo "{\\"response\\": \\"Echo: $MESSAGE\\"}"
`;

function generateFlowJson(): string {
  const start = createStartNode({
    name: 'start',
    outputs: [stringProperty({ title: 'query' })],
  });
  const agent = createAgent({
    name: 'assistant-agent',
    systemPrompt:
      "You are a helpful assistant. Answer the user's question: {{query}}",
    llmConfig: createOpenAiConfig({ name: 'openai', modelId: 'gpt-4o' }),
    tools: [
      createServerTool({
        name: 'example_tool',
        description: 'An example tool that echoes input',
        inputs: [stringProperty({ title: 'message' })],
        outputs: [stringProperty({ title: 'response' })],
      }),
    ],
  });
  const assistant = createAgentNode({
    name: 'assistant',
    agent,
    inputs: [stringProperty({ title: 'query' })],
    outputs: [stringProperty({ title: 'result' })],
  });
  const end = createEndNode({
    name: 'end',
    inputs: [stringProperty({ title: 'result' })],
  });

  const builder = new FlowBuilder();
  builder.addNode(start);
  builder.addNode(assistant);
  builder.addNode(end);
  builder.addEdge(start, assistant);
  builder.addEdge(assistant, end);
  builder.addDataEdge(start, assistant, 'query');
  builder.addDataEdge(assistant, end, 'result');

  const flow = builder.build('my-flow');
  const serializer = new AgentSpecSerializer();
  return serializer.toJson(flow, { indent: 2 }) as string;
}

/** Generate creates a new project in the given directory. */
export function generate(dir: string): void {
  const toolsDir = join(dir, 'tools');
  try {
    mkdirSync(toolsDir, { recursive: true });
  } catch (err) {
    throw new Error('failed to create directory', { cause: err });
  }

  const flowPath = join(dir, 'flow.json');
  try {
    writeFileSync(flowPath, generateFlowJson() + '\n', { mode: 0o644 });
  } catch (err) {
    throw new Error('failed to write flow.json', { cause: err });
  }

  const toolPath = join(toolsDir, 'example_tool.sh');
  try {
    writeFileSync(toolPath, toolTemplate, { mode: 0o755 });
  } catch (err) {
    throw new Error('failed to write example_tool.sh', { cause: err });
  }
}
