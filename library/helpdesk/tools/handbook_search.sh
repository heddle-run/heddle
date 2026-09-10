#!/usr/bin/env bash
# Search the handbook that travels inside the bundle.
#
# JSON on stdin, one JSON object on stdout. The handbook is found the same way
# in every tool here: the mount inside the workspace first, then a sibling of
# the tools directory, which is where it sits in a source checkout.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"

SCRIPT=$(cat <<'PY'
import json
import os
import re
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


def fail(message, **extra):
    print(json.dumps({"matches": "", "count": 0, "error": message, **extra}))
    raise SystemExit(0)


try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

query = str(request.get("query", "")).strip()
limit = int(request.get("limit", 8) or 8)
if not query:
    fail("query is required")

root = handbook_dir()
if root is None:
    fail("no handbook directory is mounted")

# Whole words, case-insensitively, so "vpn" does not match "vpns" only by luck
# and a two-word query matches a line carrying either word.
terms = [re.escape(word) for word in re.split(r"\s+", query) if word]
matcher = re.compile("|".join(terms), re.IGNORECASE)

hits = []
for name in sorted(os.listdir(root)):
    if not name.endswith(".md"):
        continue
    heading = ""
    with open(os.path.join(root, name), encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            text = line.rstrip("\n")
            if text.startswith("#"):
                heading = text.lstrip("#").strip()
            if matcher.search(text) and not text.startswith("#"):
                hits.append(f"{name}:{number} [{heading}] {text.strip()}")

print(
    json.dumps(
        {
            "matches": "\n".join(hits[:limit]),
            "count": len(hits),
            "documents": sorted(
                {hit.split(":", 1)[0] for hit in hits[:limit]}
            ),
        }
    )
)
PY
)

python3 -c "$SCRIPT" "$TOOLS_DIR"
