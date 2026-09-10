#!/usr/bin/env bash
# Change the replica count. Also gated.
set -euo pipefail
SCRIPT=$(cat <<'PY'
import datetime, json, os, sys

def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    raise SystemExit(0)

try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

service = str(request.get("service", "")).strip()
environment = str(request.get("environment", "production") or "production").strip()
reason = str(request.get("reason", "") or "").strip()
if not service:
    fail("service is required")
try:
    replicas = int(request.get("replicas"))
except (TypeError, ValueError):
    fail("replicas must be a whole number")
if replicas < 1 or replicas > 50:
    fail("replicas must be between 1 and 50")
if not reason:
    fail("reason is required — it is what the change log will say")

root = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()
record = {
    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "action": "scale",
    "service": service,
    "environment": environment,
    "replicas": replicas,
    "reason": reason,
}
try:
    with open(os.path.join(root, "changes.jsonl"), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
except OSError as err:
    fail(f"cannot record the change: {err}")

print(json.dumps({"ok": True, "action": "scale", "service": service,
                  "environment": environment, "replicas": replicas,
                  "detail": f"{service} in {environment} scaled to {replicas}"}))
PY
)
python3 -c "$SCRIPT"
