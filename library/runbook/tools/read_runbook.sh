#!/usr/bin/env bash
# The written procedure for a service, including what not to do. Read-only.
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
    print(json.dumps({"found": False, "steps": "", "error": message}))
    raise SystemExit(0)

try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

service = str(request.get("service", "")).strip()
if not service:
    fail("service is required")

path = fixture("runbooks.json")
if path is None:
    fail("no runbook fixture on this machine")
with open(path, encoding="utf-8") as handle:
    runbooks = json.load(handle)

if service not in runbooks:
    print(json.dumps({"found": False, "steps": "",
                      "error": f"no runbook for {service}",
                      "available": sorted(runbooks)}))
    raise SystemExit(0)

entry = runbooks[service]
steps = "\n".join(f"{n}. {step}" for n, step in enumerate(entry["steps"], start=1))
print(json.dumps({"found": True, "owner": entry["owner"], "page": entry["page"],
                  "steps": steps}))
PY
)
python3 -c "$SCRIPT" "$TOOLS_DIR"
