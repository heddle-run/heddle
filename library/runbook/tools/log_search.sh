#!/usr/bin/env bash
# Search recent log lines. Read-only.
set -euo pipefail
TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT=$(cat <<'PY'
import json, os, re, sys

def fixture(name):
    for base in (
        os.path.join(os.environ.get("HEDDLE_WORKSPACE", ""), "fixtures"),
        "fixtures",
        os.path.join(sys.argv[1], "..", "fixtures"),
    ):
        path = os.path.join(base, name) if base else ""
        if path and os.path.isfile(path):
            return path
    return None

def fail(message):
    print(json.dumps({"matches": "", "count": 0, "error": message}))
    raise SystemExit(0)

try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

pattern = str(request.get("pattern", "")).strip()
limit = int(request.get("limit", 20) or 20)
if not pattern:
    fail("pattern is required")
try:
    matcher = re.compile(pattern, re.IGNORECASE)
except re.error as err:
    fail(f"bad pattern: {err}")

path = fixture("app.log")
if path is None:
    fail("no log fixture on this machine")
with open(path, encoding="utf-8") as handle:
    hits = [line.rstrip("\n") for line in handle if matcher.search(line)]

print(json.dumps({"matches": "\n".join(hits[:limit]), "count": len(hits)}))
PY
)
python3 -c "$SCRIPT" "$TOOLS_DIR"
