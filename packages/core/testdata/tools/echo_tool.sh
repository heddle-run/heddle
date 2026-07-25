#!/usr/bin/env bash
# Echo tool: reads JSON from stdin, echoes it back
set -euo pipefail
INPUT=$(cat)
MESSAGE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('message',''))")
echo "{\"response\": \"Echo: $MESSAGE\"}"
