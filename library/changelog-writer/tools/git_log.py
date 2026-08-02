#!/usr/bin/env python3
"""Commits in a revision range, as structured JSON.

Reads a repository the caller names rather than the workspace it starts in: a
tool's cwd is its own scratch directory, so a relative default would find no
repository at all. Under `--safe` the path has to be granted with `--allow-read`
as well; unconfined, heddle's own permissions are the only limit.
"""

import json
import os
import subprocess
import sys

FIELD = "\x1f"
RECORD = "\x1e"
MAX_BODY = 500


def fail(message):
    """Report a failure the model can act on, and still exit 0.

    A tool that dies takes the whole run with it. Returning the error as data
    lets the agent say "that range does not exist" and try another one.
    """
    json.dump({"error": message, "count": 0, "commits": []}, sys.stdout)
    sys.exit(0)


def checked_repo(repo):
    """Reject a path that resolves inside the tool's own workspace.

    `.` is the answer everyone reaches for and it is wrong here: a tool starts
    in a scratch directory of its own, so a relative path lands there rather
    than in the repository the caller meant. Saying so beats letting git report
    "not a git repository" about a path nobody chose.

    No `$PWD` fallback on purpose. It would work unconfined, where the tool
    inherits heddle's environment, and vanish under `--safe`, where the sandbox
    clears it — and a tool that works only when unconfined is worse than one
    that always asks for the path.
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
    revision_range = str(args.get("range") or "HEAD~20..HEAD")

    try:
        limit = int(args.get("limit") or 100)
    except (TypeError, ValueError):
        limit = 100
    limit = max(1, min(limit, 500))

    # A range is a git revision, never a flag. Without this a model that guessed
    # "--all" or "--help" would be passing options to git rather than naming
    # commits, and the tool would answer a question nobody asked.
    if revision_range.startswith("-"):
        fail(f"range {revision_range!r} looks like a flag, not a revision range")

    pretty = FIELD.join(["%h", "%s", "%an", "%aI", "%b"]) + RECORD
    command = [
        "git",
        "-C",
        repo,
        "log",
        "--no-merges",
        f"--max-count={limit}",
        f"--pretty=format:{pretty}",
        revision_range,
    ]

    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=20, check=False
        )
    except FileNotFoundError:
        fail("git is not installed, or not on PATH")
    except subprocess.TimeoutExpired:
        fail("git log took longer than 20 seconds")

    if completed.returncode != 0:
        detail = completed.stderr.strip().splitlines()
        fail(detail[0] if detail else f"git log exited {completed.returncode}")

    commits = []
    for record in completed.stdout.split(RECORD):
        record = record.strip("\n")
        if not record:
            continue
        parts = record.split(FIELD)
        if len(parts) < 5:
            continue
        body = parts[4].strip()
        commits.append(
            {
                "hash": parts[0],
                "subject": parts[1],
                "author": parts[2],
                "date": parts[3],
                "body": body[:MAX_BODY],
            }
        )

    json.dump(
        {"range": revision_range, "count": len(commits), "commits": commits},
        sys.stdout,
    )


if __name__ == "__main__":
    main()
