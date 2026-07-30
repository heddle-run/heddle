#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
EXPRESSION=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('expression','0'))")
RESULT=$(python3 -c "print(eval('$EXPRESSION'))" 2>&1 || echo "error")

echo "{\"result\": \"$RESULT\"}"
