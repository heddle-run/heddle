#!/usr/bin/env bash
# Same pattern again, and that is the point: the third one took two minutes.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
for candidate in "${HEDDLE_WORKSPACE:-}/scripts" "scripts" "$HERE/../scripts"; do
  if [ -d "$candidate" ]; then SCRIPTS="$candidate"; break; fi
done

read -r -d '' -n 1048576 INPUT || true
export INPUT SCRIPTS

python3 - <<'PY'
import json
import os
import subprocess

try:
    request = json.loads(os.environ.get("INPUT") or "{}")
except json.JSONDecodeError as err:
    print(json.dumps({"people": "", "count": 0, "error": f"bad input: {err}"}))
    raise SystemExit(0)

scripts = os.environ.get("SCRIPTS")
since = str(request.get("since", "")).strip()
until = str(request.get("until", "HEAD") or "HEAD").strip()
repo = str(request.get("repo", ".") or ".").strip()

if not scripts:
    print(json.dumps({"people": "", "count": 0, "error": "no scripts directory found"}))
    raise SystemExit(0)
if not since:
    print(json.dumps({"people": "", "count": 0, "error": "since is required"}))
    raise SystemExit(0)

done = subprocess.run(
    [os.path.join(scripts, "contributors.sh"),
     "--since", since, "--until", until, "--repo", repo],
    capture_output=True, text=True,
)
if done.returncode != 0:
    print(json.dumps({
        "people": "", "count": 0,
        "error": done.stderr.strip() or f"contributors.sh exited {done.returncode}",
    }))
    raise SystemExit(0)

rows = [row.strip() for row in done.stdout.split("\n") if row.strip()]
print(json.dumps({"people": "\n".join(rows), "count": len(rows)}))
PY
