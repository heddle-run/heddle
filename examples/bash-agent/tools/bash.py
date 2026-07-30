#!/usr/bin/env python3

import json
import os
import shutil
import subprocess
import sys

MAX_STDOUT = 10_000
MAX_STDERR = 5_000

DEFAULT_TIMEOUT = 25
MAX_TIMEOUT = 25

RUNTIME_DIRS = [
    "/opt/homebrew/bin",  # Homebrew on Apple Silicon
    "/usr/local/bin",     # Homebrew on Intel, manual installs on Linux
    "/opt/nodejs/bin",    # Node tarball unpacked under /opt
    "/opt/python/bin",
]

def runtime_path(env):
    declared = env.get("HEDDLE_RUNTIME_PATH", "").split(os.pathsep)

    seen = set()
    dirs = []
    for path in [*declared, *RUNTIME_DIRS]:
        if path and path not in seen and os.path.isdir(path):
            seen.add(path)
            dirs.append(path)

    return os.pathsep.join([*dirs, env.get("PATH", "")])

def as_text(value):
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
