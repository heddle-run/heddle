#!/usr/bin/env bash
set -euo pipefail
INPUT=$(cat)

COMMAND=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('command','echo no command'))")
WORKDIR=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('working_directory','.'))")

STDOUT_FILE=$(mktemp)
STDERR_FILE=$(mktemp)
trap 'rm -f "$STDOUT_FILE" "$STDERR_FILE"' EXIT

EXIT_CODE=0
if command -v timeout &>/dev/null; then
  cd "$WORKDIR" && timeout 25 sh -c "$COMMAND" >"$STDOUT_FILE" 2>"$STDERR_FILE" || EXIT_CODE=$?
elif command -v gtimeout &>/dev/null; then
  cd "$WORKDIR" && gtimeout 25 bash -c "$COMMAND" >"$STDOUT_FILE" 2>"$STDERR_FILE" || EXIT_CODE=$?
else
  cd "$WORKDIR" && bash -c "$COMMAND" >"$STDOUT_FILE" 2>"$STDERR_FILE" || EXIT_CODE=$?
fi

python3 -c "
import json, sys

with open(sys.argv[1]) as f:
    stdout = f.read()
with open(sys.argv[2]) as f:
    stderr = f.read()

if len(stdout) > 10000:
    stdout = stdout[:10000] + '\n... (truncated)'
if len(stderr) > 5000:
    stderr = stderr[:5000] + '\n... (truncated)'

json.dump({
    'stdout': stdout,
    'stderr': stderr,
    'exit_code': int(sys.argv[3])
}, sys.stdout)
" "$STDOUT_FILE" "$STDERR_FILE" "$EXIT_CODE"
