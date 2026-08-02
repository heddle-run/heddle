#!/usr/bin/env python3
"""Find the lines in the mounted docs that match a query.

Retrieval without a vector database: the corpus is a directory of files, the
index is built per call, and what comes back is a file and a line number the
agent can go and read. For a folder of notes, a handbook or a runbook set —
anything a person would have used grep on — that is the whole of what a
retrieval step needs to be.
"""

import json
import os
import re
import sys

DOCS_DIR = "docs"
EXTENSIONS = (".md", ".mdx", ".markdown", ".txt", ".rst")
MAX_MATCHES = 40
MAX_LINE = 300
MAX_FILE_BYTES = 2_000_000


def fail(message):
    json.dump({"error": message, "count": 0, "matches": []}, sys.stdout)
    sys.exit(0)


def pattern_for(query):
    """The query as a regex, or as literal text when it is not a valid one.

    A model writing `C++ (v2)` means those characters, not a broken group. The
    fallback is what stops a reasonable query from being an error the agent has
    to recover from.
    """
    try:
        return re.compile(query, re.IGNORECASE), "regex"
    except re.error:
        return re.compile(re.escape(query), re.IGNORECASE), "literal"


def main():
    try:
        args = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        fail(f"could not parse input JSON: {exc}")

    query = str(args.get("query") or "").strip()
    if not query:
        fail("no query was given")

    try:
        limit = int(args.get("limit") or 20)
    except (TypeError, ValueError):
        limit = 20
    limit = max(1, min(limit, MAX_MATCHES))

    if not os.path.isdir(DOCS_DIR):
        fail(
            f"no {DOCS_DIR}/ directory in this workspace — mount one with "
            f'--mount "./your-notes:{DOCS_DIR}"'
        )

    pattern, kind = pattern_for(query)

    matches = []
    files_searched = 0
    for root, dirs, files in os.walk(DOCS_DIR):
        dirs[:] = sorted(d for d in dirs if not d.startswith("."))
        for filename in sorted(files):
            if not filename.lower().endswith(EXTENSIONS):
                continue
            path = os.path.join(root, filename)
            try:
                if os.path.getsize(path) > MAX_FILE_BYTES:
                    continue
                with open(path, encoding="utf-8", errors="replace") as handle:
                    lines = handle.readlines()
            except OSError:
                continue

            files_searched += 1
            for number, line in enumerate(lines, start=1):
                if len(matches) >= limit:
                    break
                if pattern.search(line):
                    matches.append(
                        {
                            "path": os.path.relpath(path, DOCS_DIR),
                            "line": number,
                            "text": line.strip()[:MAX_LINE],
                        }
                    )
            if len(matches) >= limit:
                break
        if len(matches) >= limit:
            break

    json.dump(
        {
            "query": query,
            "matched_as": kind,
            "files_searched": files_searched,
            "count": len(matches),
            "matches": matches,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
