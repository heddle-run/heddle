#!/usr/bin/env bash
# Read a window of lines around a point in one document.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"

SCRIPT=$(cat <<'PY'
import json
import os
import sys


def documents_dir():
    for path in (
        os.path.join(os.environ.get("HEDDLE_WORKSPACE", ""), "documents"),
        "documents",
        os.path.join(sys.argv[1], "..", "documents"),
    ):
        if path and os.path.isdir(path):
            return path
    return None


def fail(message):
    print(json.dumps({"text": "", "found": False, "error": message}))
    raise SystemExit(0)


try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

document = str(request.get("document", "")).strip()
if not document:
    fail("document is required")
if "/" in document or os.sep in document or ".." in document:
    fail("document must be a plain file name")

try:
    line = int(request.get("line", 1) or 1)
    context = int(request.get("context", 6) or 6)
except (TypeError, ValueError):
    fail("line and context must be numbers")

root = documents_dir()
if root is None:
    fail("no documents directory. Mount one with --mount ~/your-folder:documents:ro")

path = os.path.join(root, document)
if not os.path.isfile(path):
    fail(f"no such document: {document}")

with open(path, encoding="utf-8", errors="replace") as handle:
    lines = handle.read().split("\n")

first = max(1, line - context)
last = min(len(lines), line + context)

# Numbered, so a citation taken from this excerpt is right without counting.
window = "\n".join(
    f"{number}: {lines[number - 1]}" for number in range(first, last + 1)
)

print(
    json.dumps(
        {
            "text": window,
            "found": True,
            "document": document,
            "lines": f"{first}-{last}",
        }
    )
)
PY
)

python3 -c "$SCRIPT" "$TOOLS_DIR"
