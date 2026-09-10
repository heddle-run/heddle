#!/usr/bin/env bash
# A rolling restart. This one changes production, which is why the operator
# gates it — the script itself asks nobody anything, and should not: a tool that
# negotiates its own permission is a tool whose permission cannot be changed
# without editing it.
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
if not reason:
    fail("reason is required — it is what the change log will say")

root = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()
record = {
    "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
    "action": "restart",
    "service": service,
    "environment": environment,
    "reason": reason,
}
try:
    with open(os.path.join(root, "changes.jsonl"), "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record) + "\n")
except OSError as err:
    fail(f"cannot record the change: {err}")

print(json.dumps({"ok": True, "action": "restart", "service": service,
                  "environment": environment,
                  "detail": f"rolling restart of {service} in {environment} started"}))
PY
)
python3 -c "$SCRIPT"
