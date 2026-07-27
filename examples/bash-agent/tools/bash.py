#!/usr/bin/env python3
"""bash tool: runs a shell command and returns stdout, stderr, and exit code.

Two things it does beyond spawning a shell, both of them for the sandbox's sake:

  * PATH. A confined tool is handed a fixed PATH of system directories only, so
    an interpreter installed anywhere else — Homebrew, nvm, a tarball under
    /opt — stays invisible even when the sandbox can read it. The directories
    in RUNTIME_DIRS are prepended when they exist, and $HEDDLE_RUNTIME_PATH
    adds any others (forward it with `--allow-env HEDDLE_RUNTIME_PATH`, and
    grant `--allow-read` on the directory itself).

  * Working directory. Under --safe the working directory is read-only and
    $HEDDLE_WORKSPACE is the one writable place, so commands run there unless
    the caller names somewhere else.

Failures are reported in the JSON result, never by exiting non-zero: heddle
treats a tool that exits non-zero as a broken tool, but a command that fails is
ordinary and the model should see it and react.
"""

import json
import os
import shutil
import subprocess
import sys

# Long output costs context and rarely earns it; the tail is what gets cut.
MAX_STDOUT = 10_000
MAX_STDERR = 5_000

# Both under heddle's own 30s tool timeout, so a slow command comes back as a
# result the model can read instead of a killed subprocess.
DEFAULT_TIMEOUT = 25
MAX_TIMEOUT = 25

# Where interpreters live when they are not in /usr/bin. Checked in order,
# after anything named in $HEDDLE_RUNTIME_PATH.
RUNTIME_DIRS = [
    "/opt/homebrew/bin",  # Homebrew on Apple Silicon
    "/usr/local/bin",     # Homebrew on Intel, manual installs on Linux
    "/opt/nodejs/bin",    # Node tarball unpacked under /opt
    "/opt/python/bin",
]


def runtime_path(env):
    """PATH with the interpreter directories that exist prepended."""
    declared = env.get("HEDDLE_RUNTIME_PATH", "").split(os.pathsep)

    seen = set()
    dirs = []
    for path in [*declared, *RUNTIME_DIRS]:
        if path and path not in seen and os.path.isdir(path):
            seen.add(path)
            dirs.append(path)

    return os.pathsep.join([*dirs, env.get("PATH", "")])


def as_text(value):
    """Partial output from a timeout arrives as str or bytes depending on how
    far the child got; normalize both."""
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value


def truncate(text, limit):
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... (truncated, {len(text)} chars total)"


def emit(stdout, stderr, exit_code):
    json.dump(
        {
            "stdout": truncate(as_text(stdout), MAX_STDOUT),
            "stderr": truncate(as_text(stderr), MAX_STDERR),
            "exit_code": exit_code,
        },
        sys.stdout,
    )


def resolve_timeout(value):
    try:
        seconds = int(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return max(1, min(seconds, MAX_TIMEOUT))


def run():
    try:
        data = json.load(sys.stdin)
    except ValueError as err:
        emit("", f"invalid tool input: {err}", 1)
        return

    command = (data.get("command") or "").strip()
    if not command:
        emit("", "no command provided", 1)
        return

    env = dict(os.environ)
    env["PATH"] = runtime_path(env)

    workdir = data.get("working_directory") or env.get("HEDDLE_WORKSPACE") or os.getcwd()
    # No shell has touched this one, so "$HEDDLE_WORKSPACE/build" would otherwise
    # arrive as a literal directory name that cannot exist.
    workdir = os.path.expanduser(os.path.expandvars(workdir))
    if not os.path.isdir(workdir):
        emit("", f"working_directory does not exist: {workdir}", 1)
        return

    timeout = resolve_timeout(data.get("timeout"))
    shell = shutil.which("bash", path=env["PATH"]) or "/bin/sh"

    try:
        result = subprocess.run(
            [shell, "-c", command],
            cwd=workdir,
            env=env,
            # The tool's own stdin is already spent on the JSON input, and a
            # command that waits for a terminal would hang until the timeout.
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as err:
        stderr = as_text(err.stderr) + f"\ncommand timed out after {timeout}s"
        emit(err.stdout, stderr, 124)
        return
    except OSError as err:
        emit("", f"failed to run command: {err}", 1)
        return

    emit(result.stdout, result.stderr, result.returncode)


try:
    run()
except Exception as err:  # a crash here must still read as a failed command
    emit("", f"bash tool error: {err}", 1)
