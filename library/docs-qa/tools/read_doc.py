#!/usr/bin/env python3
"""Read one of the mounted docs, or a window of it.

The other half of search_docs: a match is a line number, and an answer needs
the paragraph around it. Windowed rather than whole-file because a handbook page
can be longer than the context you want to spend on it.
"""

import json
import os
import sys

DOCS_DIR = "docs"
DEFAULT_LINES = 120
MAX_LINES = 400
MAX_CHARS = 20_000


def fail(message):
    json.dump({"error": message, "text": ""}, sys.stdout)
    sys.exit(0)


def resolved_under_docs(raw):
    """Refuse a path that leaves the docs directory.

    The mount is read-only and this tool only reads, so nothing here is at risk
    of being written. What the check is for is honesty about scope: this tool
    answers from the corpus it was pointed at, and `../../etc/passwd` is not in
    it. Without `--safe` nothing else would stop the read.
    """
    base = os.path.realpath(DOCS_DIR)
    candidate = os.path.realpath(os.path.join(DOCS_DIR, raw))
    if candidate != base and not candidate.startswith(base + os.sep):
        fail(f"path {raw!r} is outside {DOCS_DIR}/")
    return candidate


def main():
    try:
        args = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        fail(f"could not parse input JSON: {exc}")

    raw_path = str(args.get("path") or "").strip()
    if not raw_path:
        fail("no path was given")

    try:
        start = int(args.get("start") or 1)
    except (TypeError, ValueError):
        start = 1
    start = max(1, start)

    try:
        count = int(args.get("lines") or DEFAULT_LINES)
    except (TypeError, ValueError):
        count = DEFAULT_LINES
    count = max(1, min(count, MAX_LINES))

    if not os.path.isdir(DOCS_DIR):
        fail(
            f"no {DOCS_DIR}/ directory in this workspace — mount one with "
            f'--mount "./your-notes:{DOCS_DIR}"'
        )

    path = resolved_under_docs(raw_path.lstrip("/"))

    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            lines = handle.readlines()
    except IsADirectoryError:
        fail(f"{raw_path!r} is a directory, not a document")
    except FileNotFoundError:
        fail(f"no document at {raw_path!r} — search_docs returns usable paths")
    except OSError as exc:
        fail(f"could not read {raw_path!r}: {exc}")

    window = lines[start - 1 : start - 1 + count]
    text = "".join(window)[:MAX_CHARS]

    json.dump(
        {
            "path": raw_path,
            "start": start,
            "returned_lines": len(window),
            "total_lines": len(lines),
            "truncated": start - 1 + len(window) < len(lines),
            "text": text,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
