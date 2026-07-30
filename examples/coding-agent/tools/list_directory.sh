#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)

DIR_PATH=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('path','.'))")

if [ ! -d "$DIR_PATH" ]; then
  python3 -c "import json,sys; json.dump({'entries': 'Error: directory not found: ' + sys.argv[1]}, sys.stdout)" "$DIR_PATH"
  exit 0
fi

ENTRIES=$(find "$DIR_PATH" -maxdepth 1 2>&1 || true)
python3 -c "import json,sys; json.dump({'entries': sys.argv[1]}, sys.stdout)" "$ENTRIES"
