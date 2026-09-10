#!/usr/bin/env bash
# What shipped lately, and what it would roll back to. Read-only.
set -euo pipefail
TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT=$(cat <<'PY'
import json, os, sys

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
    print(json.dumps({"deploys": "", "count": 0, "error": message}))
    raise SystemExit(0)

try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

service = str(request.get("service", "")).strip()
limit = int(request.get("limit", 5) or 5)
if not service:
    fail("service is required")

path = fixture("deploys.json")
if path is None:
    fail("no deploy fixture on this machine")
with open(path, encoding="utf-8") as handle:
    deploys = json.load(handle)

if service not in deploys:
    fail(f"no such service: {service}. Known: {', '.join(sorted(deploys))}")

rows = deploys[service][:limit]
lines = [
    f"{row['at']} {row['version']} by {row['by']} — {row['change']} "
    f"(rollback target {row['rollback_to']})"
    for row in rows
]
print(json.dumps({"deploys": "\n".join(lines) or "no deploys recorded",
                  "count": len(rows)}))
PY
)
python3 -c "$SCRIPT" "$TOOLS_DIR"
