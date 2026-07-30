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

const FLOW_FILE_MODE = 0o644;
const TOOL_FILE_MODE = 0o755;

const EXAMPLE_TOOL = `#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message','no message'))" 2>/dev/null || echo "no message")

echo "{\\"response\\": \\"Echo: $MESSAGE\\"}"
`;

export function generate(dir: string): void {
  const toolsDir = join(dir, 'tools');

  attempt('failed to create directory', () =>
    mkdirSync(toolsDir, { recursive: true }),
  );
  attempt('failed to write flow.json', () =>
    writeFileSync(join(dir, 'flow.json'), `${generateFlowJson()}\n`, {
      mode: FLOW_FILE_MODE,
    }),
  );
  attempt('failed to write example_tool.sh', () =>
    writeFileSync(join(toolsDir, 'example_tool.sh'), EXAMPLE_TOOL, {
      mode: TOOL_FILE_MODE,
    }),
  );
}

function generateFlowJson(): string {
  const start = createStartNode({
    name: 'start',
    outputs: [stringProperty({ title: 'query' })],
  });
  const assistant = createAgentNode({
    name: 'assistant',
    agent: createExampleAgent(),
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

  const serializer = new AgentSpecSerializer();
  return serializer.toJson(builder.build('my-flow'), { indent: 2 }) as string;
}

function createExampleAgent() {
  return createAgent({
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
}

function attempt(message: string, action: () => void): void {
  try {
    action();
  } catch (err) {
    throw new Error(message, { cause: err });
  }
}
