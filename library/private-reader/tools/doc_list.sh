#!/usr/bin/env bash
# List the documents. JSON on stdin, one JSON object on stdout.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"

SCRIPT=$(cat <<'PY'
import fnmatch
import json
import os
import sys

TEXTUAL = (".md", ".txt", ".csv", ".json", ".eml", ".rtf")


def documents_dir():
    for path in (
        os.path.join(os.environ.get("HEDDLE_WORKSPACE", ""), "documents"),
        "documents",
        os.path.join(sys.argv[1], "..", "documents"),
    ):
        if path and os.path.isdir(path):
            return path
    return None


try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    print(json.dumps({"documents": "", "count": 0, "error": f"bad input: {err}"}))
    raise SystemExit(0)

pattern = str(request.get("pattern", "") or "").strip()

root = documents_dir()
if root is None:
    print(
        json.dumps(
            {
                "documents": "",
                "count": 0,
                "error": "no documents directory. Mount one with --mount ~/your-folder:documents:ro",
            }
        )
    )
    raise SystemExit(0)

rows = []
for name in sorted(os.listdir(root)):
    path = os.path.join(root, name)
    if not os.path.isfile(path) or name.startswith("."):
        continue
    if pattern and not fnmatch.fnmatch(name.lower(), f"*{pattern.lower()}*"):
        continue
    if not name.lower().endswith(TEXTUAL):
        # Named but not counted: a reader deserves to know a PDF is sitting
        # there unread rather than to be told the folder holds nothing.
        rows.append(f"{name}\t(not plain text; convert it to read it here)")
        continue
    with open(path, encoding="utf-8", errors="replace") as handle:
        lines = sum(1 for _ in handle)
    rows.append(f"{name}\t{lines} lines\t{os.path.getsize(path)} bytes")

print(json.dumps({"documents": "\n".join(rows), "count": len(rows)}))
PY
)

python3 -c "$SCRIPT" "$TOOLS_DIR"
