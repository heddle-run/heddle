#!/usr/bin/env bash
# A heddle tool in shell: JSON on stdin, one JSON object on stdout.
#
# Uses python3 to read the input and to build the output, because a shell that
# builds JSON by string concatenation breaks on the first quote in the data —
# and the data here is log lines.
set -euo pipefail

LOG_FILE="$(cd "$(dirname "$0")/.." && pwd)/fixtures/app.log"

# The script is captured into a variable and passed with -c, not piped in.
# `python3 - <<'PY'` would make the heredoc python's *stdin* — which is where the
# tool's JSON input is, so the input would be gone.
SCRIPT=$(cat <<'PY'
import json
import re
import sys

log_file = sys.argv[1]

try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    print(json.dumps({"matches": "", "count": 0, "error": f"bad input: {err}"}))
    raise SystemExit(0)

pattern = str(request.get("pattern", "")).strip()
limit = int(request.get("limit", 5) or 5)

if not pattern:
    print(json.dumps({"matches": "", "count": 0, "error": "pattern is required"}))
    raise SystemExit(0)

try:
    matcher = re.compile(pattern, re.IGNORECASE)
except re.error as err:
    print(json.dumps({"matches": "", "count": 0, "error": f"bad pattern: {err}"}))
    raise SystemExit(0)

try:
    with open(log_file, encoding="utf-8") as handle:
        hits = [line.rstrip("\n") for line in handle if matcher.search(line)]
except OSError as err:
    print(json.dumps({"matches": "", "count": 0, "error": f"cannot read log: {err}"}))
    raise SystemExit(0)

print(json.dumps({"matches": "\n".join(hits[:limit]), "count": len(hits)}))
PY
)

python3 -c "$SCRIPT" "$LOG_FILE"
