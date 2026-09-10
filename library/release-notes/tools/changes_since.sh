#!/usr/bin/env bash
# The shim. Fifteen lines between a script your team already had and a tool an
# agent can call: read JSON from stdin, spend it as flags, print one JSON object.
#
# The script in ../scripts is not touched, not imported and not ported. It is
# executed exactly as a person would execute it, and it keeps working for the
# person who has been running it by hand since 2023.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# The scripts directory: the workspace copy first, then a sibling of tools/.
for candidate in "${HEDDLE_WORKSPACE:-}/scripts" "scripts" "$HERE/../scripts"; do
  if [ -d "$candidate" ]; then SCRIPTS="$candidate"; break; fi
done

read -r -d '' -n 1048576 INPUT || true
export INPUT SCRIPTS

python3 - "$@" <<'PY'
import json
import os
import subprocess
import sys

try:
    request = json.loads(os.environ.get("INPUT") or "{}")
except json.JSONDecodeError as err:
    print(json.dumps({"commits": "", "count": 0, "error": f"bad input: {err}"}))
    raise SystemExit(0)

scripts = os.environ.get("SCRIPTS")
if not scripts:
    print(json.dumps({"commits": "", "count": 0, "error": "no scripts directory found"}))
    raise SystemExit(0)

since = str(request.get("since", "")).strip()
until = str(request.get("until", "HEAD") or "HEAD").strip()
repo = str(request.get("repo", ".") or ".").strip()
if not since:
    print(json.dumps({"commits": "", "count": 0, "error": "since is required"}))
    raise SystemExit(0)

done = subprocess.run(
    [os.path.join(scripts, "changes_since.sh"),
     "--since", since, "--until", until, "--repo", repo],
    capture_output=True,
    text=True,
)

# The script's own exit code and stderr are the error. Inventing a friendlier
# one here would hide the thing the person debugging actually needs.
if done.returncode != 0:
    print(json.dumps({
        "commits": "", "count": 0,
        "error": done.stderr.strip() or f"changes_since.sh exited {done.returncode}",
    }))
    raise SystemExit(0)

lines = [line for line in done.stdout.split("\n") if line.strip()]
print(json.dumps({"commits": "\n".join(lines), "count": len(lines)}))
PY
