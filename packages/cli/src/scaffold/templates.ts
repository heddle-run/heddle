import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

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
  attempt('failed to write weave.yaml', () =>
    writeFileSync(join(dir, 'weave.yaml'), weaveTemplate(projectName(dir)), {
      mode: FLOW_FILE_MODE,
    }),
  );
  attempt('failed to write example_tool.sh', () =>
    writeFileSync(join(toolsDir, 'example_tool.sh'), EXAMPLE_TOOL, {
      mode: TOOL_FILE_MODE,
    }),
  );
}

function projectName(dir: string): string {
  const name = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '');
  return name || 'my-flow';
}

function weaveTemplate(name: string): string {
  return `weave: 1
name: ${name}
description: A starter agent that answers a question, with one tool to call.

inputs:
  query: string

tools:
  example_tool:
    description: An example tool that echoes input.
    inputs:
      message: string
    outputs:
      response: string

agent:
  model:
    provider: openai
    model: gpt-4o
    api_key: $OPENAI_API_KEY
  prompt: |
    You are a helpful assistant. Answer the user's question: {{inputs.query}}
  tools: [example_tool]
`;
}

function attempt(message: string, action: () => void): void {
  try {
    action();
  } catch (err) {
    throw new Error(message, { cause: err });
  }
}
