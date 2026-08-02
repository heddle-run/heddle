#!/usr/bin/env python3
"""The most recent tags in a repository, newest first.

What makes the agent able to answer "what changed since the last release?"
without being told what the last release was.
"""

import json
import os
import subprocess
import sys

FIELD = "\x1f"


def fail(message):
    json.dump({"error": message, "count": 0, "tags": []}, sys.stdout)
    sys.exit(0)


def checked_repo(repo):
    """Reject a path that resolves inside the tool's own workspace.

    See the longer note in git_log.py: a tool's cwd is its scratch directory,
    so a relative path never means the caller's repository.
    """
    workspace = os.environ.get("HEDDLE_WORKSPACE")
    resolved = os.path.realpath(repo)
    if workspace and (
        resolved == os.path.realpath(workspace)
        or resolved.startswith(os.path.realpath(workspace) + os.sep)
    ):
        fail(
            f"repo {repo!r} resolved to {resolved}, which is this tool's "
            "workspace and not a repository. Pass an absolute path to the "
            "repository instead."
        )
    return repo


def main():
    try:
        args = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as exc:
        fail(f"could not parse input JSON: {exc}")

    repo = checked_repo(str(args.get("repo") or "."))

    try:
        limit = int(args.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 100))

    command = [
        "git",
        "-C",
        repo,
        "for-each-ref",
        "--sort=-creatordate",
        f"--count={limit}",
        f"--format=%(refname:short){FIELD}%(creatordate:short)",
        "refs/tags",
    ]

    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=20, check=False
        )
    except FileNotFoundError:
        fail("git is not installed, or not on PATH")
    except subprocess.TimeoutExpired:
        fail("git for-each-ref took longer than 20 seconds")

    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        fail(detail[0] if detail else f"git exited {completed.returncode}")

    tags = []
    for line in completed.stdout.splitlines():
        if not line.strip():
            continue
        name, _, date = line.partition(FIELD)
        tags.append({"tag": name, "date": date})

    json.dump({"count": len(tags), "tags": tags}, sys.stdout)


if __name__ == "__main__":
    main()
