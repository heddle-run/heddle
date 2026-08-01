#!/usr/bin/env python3
"""Run a shell command in the workspace.

The workspace is already this process's working directory and its `bin` is
already first on `$PATH`, so a command can name a peer tool — `read_skill`,
`write_file` — and get it. The `cd` is belt and braces for a tool invoked from
somewhere else.
"""
import json, os, subprocess, sys

data = json.load(sys.stdin)
command = (data.get("command") or "").strip()

workdir = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()

try:
    done = subprocess.run(
        ["bash", "-c", command],
        cwd=workdir,
        # Nothing interactive can work here: this process's stdin was the JSON
        # above, and a command that waits for a terminal would just time out.
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=20,
    )
    stdout, stderr, code = done.stdout, done.stderr, done.returncode
except subprocess.TimeoutExpired:
    stdout, stderr, code = "", "command timed out after 20s", 124

# Exit 0 whatever happened. A tool that exits non-zero is a broken tool and the
# engine abandons the round -- which would take the error message away from the
# one reader who can act on it.
json.dump(
    {"stdout": stdout[:4000], "stderr": stderr[:2000], "exit_code": code},
    sys.stdout,
)
