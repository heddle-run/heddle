#!/usr/bin/env bash
# Delegate task tool: runs a sub-agent flow via heddle run.
set -euo pipefail
INPUT=$(cat)

parse_json_field() {
  echo "$INPUT" | python3 -c "import sys, json; sys.stdout.write(json.load(sys.stdin).get(sys.argv[1], ''))" "$1"
}

AGENT_NAME=$(parse_json_field 'agent_name')
TASK=$(parse_json_field 'task')

if [ -z "$AGENT_NAME" ]; then
  echo '{"result": "Error: no agent_name provided. Available agents: code_reviewer, test_writer"}'
  exit 0
fi

if [ -z "$TASK" ]; then
  echo '{"result": "Error: no task provided"}'
  exit 0
fi

# Resolve the agents directory relative to this script's location
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
AGENT_SPEC="$AGENTS_DIR/${AGENT_NAME}.yaml"

if [ ! -f "$AGENT_SPEC" ]; then
  echo "{\"result\": \"Error: agent not found: $AGENT_NAME. Available agents: code_reviewer, test_writer\"}"
  exit 0
fi

# Build the input JSON with the task
INPUT_JSON=$(python3 -c "import json,sys; json.dump({'task': sys.argv[1]}, sys.stdout)" "$TASK")

# Run the sub-agent flow via heddle. The `heddle` bin ships inside @heddle/cli,
# so npx needs --package to find it; a bare `npx heddle` looks for a package
# named "heddle" instead.
OUTPUT=$(npx --package=@heddle/cli heddle run "$AGENT_SPEC" --input "$INPUT_JSON" 2>&1) || { echo "Error: sub-agent execution failed"; exit 1; }

# Extract the result from the heddle output
python3 -c "
import json, sys

output = sys.argv[1]

# Try to parse as JSON and extract the result field
try:
    data = json.loads(output)
    result = data.get('result', output)
    json.dump({'result': result}, sys.stdout)
except (json.JSONDecodeError, ValueError):
    # If not JSON, return raw output
    json.dump({'result': output}, sys.stdout)
" "$OUTPUT"
