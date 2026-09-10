#!/usr/bin/env bash
# Two of the team's scripts, piped into each other the way the release engineer
# pipes them. The shim's whole job is the pipe and the JSON.
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
    print(json.dumps({"tickets": "", "count": 0, "error": f"bad input: {err}"}))
    raise SystemExit(0)

scripts = os.environ.get("SCRIPTS")
since = str(request.get("since", "")).strip()
until = str(request.get("until", "HEAD") or "HEAD").strip()
repo = str(request.get("repo", ".") or ".").strip()
prefix = str(request.get("prefix", "ENG") or "ENG").strip()

if not scripts:
    print(json.dumps({"tickets": "", "count": 0, "error": "no scripts directory found"}))
    raise SystemExit(0)
if not since:
    print(json.dumps({"tickets": "", "count": 0, "error": "since is required"}))
    raise SystemExit(0)

log = subprocess.run(
    [os.path.join(scripts, "changes_since.sh"),
     "--since", since, "--until", until, "--repo", repo],
    capture_output=True, text=True,
)
if log.returncode != 0:
    print(json.dumps({
        "tickets": "", "count": 0,
        "error": log.stderr.strip() or f"changes_since.sh exited {log.returncode}",
    }))
    raise SystemExit(0)

ids = subprocess.run(
    [os.path.join(scripts, "issue_ids.py"), "--prefix", prefix, "--count"],
    input=log.stdout, capture_output=True, text=True,
)

# issue_ids.py exits 1 when it finds nothing, which is not a failure here —
# a release with no ticket references is a real release.
if ids.returncode not in (0, 1):
    print(json.dumps({
        "tickets": "", "count": 0,
        "error": ids.stderr.strip() or f"issue_ids.py exited {ids.returncode}",
    }))
    raise SystemExit(0)

rows = [row for row in ids.stdout.split("\n") if row.strip()]
print(json.dumps({
    "tickets": "\n".join(rows),
    "count": len(rows),
    "note": ids.stderr.strip() if not rows else "",
}))
PY
