#!/usr/bin/env bash
# Read one handbook document, or one section of it.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"

SCRIPT=$(cat <<'PY'
import json
import os
import sys


def handbook_dir():
    candidates = [
        os.path.join(os.environ.get("HEDDLE_WORKSPACE", ""), "handbook"),
        "handbook",
        os.path.join(sys.argv[1], "..", "handbook"),
    ]
    for path in candidates:
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
section = str(request.get("section", "") or "").strip().lower()
if not document:
    fail("document is required")

root = handbook_dir()
if root is None:
    fail("no handbook directory is mounted")

# The model is given names like "vpn.md" by the search tool, but asks for "vpn"
# about as often. Both resolve; anything with a path separator does not.
if os.sep in document or "/" in document or ".." in document:
    fail("document must be a plain file name")
name = document if document.endswith(".md") else f"{document}.md"
path = os.path.join(root, name)
if not os.path.isfile(path):
    available = sorted(f for f in os.listdir(root) if f.endswith(".md"))
    print(
        json.dumps(
            {
                "text": "",
                "found": False,
                "error": f"no such document: {name}",
                "available": available,
            }
        )
    )
    raise SystemExit(0)

with open(path, encoding="utf-8") as handle:
    lines = handle.read().split("\n")

if not section:
    print(json.dumps({"text": "\n".join(lines), "found": True, "document": name}))
    raise SystemExit(0)

wanted, collecting, depth = [], False, 0
for line in lines:
    if line.startswith("#"):
        level = len(line) - len(line.lstrip("#"))
        title = line.lstrip("#").strip().lower()
        if collecting and level <= depth:
            break
        if section in title:
            collecting, depth = True, level
    if collecting:
        wanted.append(line)

if not wanted:
    print(
        json.dumps(
            {
                "text": "",
                "found": False,
                "error": f'no section matching "{section}" in {name}',
            }
        )
    )
    raise SystemExit(0)

print(json.dumps({"text": "\n".join(wanted), "found": True, "document": name}))
PY
)

python3 -c "$SCRIPT" "$TOOLS_DIR"
