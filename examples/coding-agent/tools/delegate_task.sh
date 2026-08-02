#!/usr/bin/env bash
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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENTS_DIR="$SCRIPT_DIR/../agents"
AGENT_SPEC="$AGENTS_DIR/${AGENT_NAME}.yaml"

if [ ! -f "$AGENT_SPEC" ]; then
  echo "{\"result\": \"Error: agent not found: $AGENT_NAME. Available agents: code_reviewer, test_writer\"}"
  exit 0
fi

INPUT_JSON=$(python3 -c "import json,sys; json.dump({'task': sys.argv[1]}, sys.stdout)" "$TASK")

OUTPUT=$(npx --package=@heddle-run/cli heddle run "$AGENT_SPEC" --input "$INPUT_JSON" 2>&1) || { echo "Error: sub-agent execution failed"; exit 1; }

python3 -c "
import json, sys

output = sys.argv[1]

try:
    data = json.loads(output)
    result = data.get('result', output)
    json.dump({'result': result}, sys.stdout)
except (json.JSONDecodeError, ValueError):
    json.dump({'result': output}, sys.stdout)
" "$OUTPUT"
