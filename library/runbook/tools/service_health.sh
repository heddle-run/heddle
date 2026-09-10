#!/usr/bin/env bash
# Current state of a service. Read-only, so nothing gates it.
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
    print(json.dumps({"found": False, "error": message}))
    raise SystemExit(0)

try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

service = str(request.get("service", "")).strip()
environment = str(request.get("environment", "production") or "production").strip()
if not service:
    fail("service is required")

path = fixture("infra.json")
if path is None:
    fail("no infra fixture on this machine")
with open(path, encoding="utf-8") as handle:
    infra = json.load(handle)

if service not in infra:
    fail(f"no such service: {service}. Known: {', '.join(sorted(infra))}")
if environment not in infra[service]:
    fail(f"{service} has no {environment}. Known: {', '.join(sorted(infra[service]))}")

print(json.dumps({"found": True, "service": service, "environment": environment,
                  **infra[service][environment]}))
PY
)
python3 -c "$SCRIPT" "$TOOLS_DIR"
