#!/usr/bin/env bash
# Search every document. Hits come back as `file.ext:line text`, which is the
# citation form the answer is required to use — the tool hands the model the
# shape of the evidence, so citing is the path of least effort.
set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"

SCRIPT=$(cat <<'PY'
import json
import os
import re
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


def fail(message):
    print(json.dumps({"hits": "", "count": 0, "error": message}))
    raise SystemExit(0)


try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

query = str(request.get("query", "")).strip()
limit = int(request.get("limit", 12) or 12)
if not query:
    fail("query is required")

root = documents_dir()
if root is None:
    fail("no documents directory. Mount one with --mount ~/your-folder:documents:ro")

# Treated as a phrase, with the words allowed to be separated by any run of
# whitespace, so a search that spans a line wrap still lands.
words = [re.escape(word) for word in re.split(r"\s+", query) if word]
if not words:
    fail("query is required")
matcher = re.compile(r"\s+".join(words), re.IGNORECASE)

hits, total = [], 0
for name in sorted(os.listdir(root)):
    path = os.path.join(root, name)
    if not os.path.isfile(path) or not name.lower().endswith(TEXTUAL):
        continue
    with open(path, encoding="utf-8", errors="replace") as handle:
        for number, line in enumerate(handle, start=1):
            if matcher.search(line):
                total += 1
                if len(hits) < limit:
                    hits.append(f"{name}:{number} {line.strip()}")

print(json.dumps({"hits": "\n".join(hits), "count": total, "shown": len(hits)}))
PY
)

python3 -c "$SCRIPT" "$TOOLS_DIR"
