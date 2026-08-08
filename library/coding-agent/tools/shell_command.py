#!/usr/bin/env python3
"""Codex's shell_command tool: one shell string in, the Codex block out.

The command runs through `bash -lc` (Codex runs the user's login shell), with
stderr interleaved into stdout the way Codex aggregates the two streams. The
answer is Codex's exact format:

    Exit code: 0
    Wall time: 0.3 seconds
    Total output lines: 214        <- only when truncation dropped lines
    Output:
    ...

A timeout SIGKILLs the process group, reports exit code 124, and prefixes the
output with "command timed out after N milliseconds" — Codex's numbers and
words. Codex also intercepts `apply_patch` invoked through the shell rather
than executing it, and so does this: the patch is handed to the apply_patch
tool, never to bash.
"""

import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time

DEFAULT_TIMEOUT_MS = 10_000
RAW_CAP = 1_048_576       # Codex caps raw capture at 1 MiB
MODEL_BUDGET = 10_000     # then middle-truncates to 10 000 bytes for the model

RUNTIME_DIRS = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/opt/nodejs/bin",
    "/opt/python/bin",
]


def emit(obj):
    json.dump(obj, sys.stdout)


def runtime_path(env):
    declared = env.get("HEDDLE_RUNTIME_PATH", "").split(os.pathsep)
    seen = set()
    dirs = []
    for path in [*declared, *RUNTIME_DIRS]:
        if path and path not in seen and os.path.isdir(path):
            seen.add(path)
            dirs.append(path)
    return os.pathsep.join([*dirs, env.get("PATH", "")])


def middle_truncate(text):
    """Codex's model truncation: half the budget as head, half as tail."""
    if len(text) <= MODEL_BUDGET:
        return text, 0
    half = MODEL_BUDGET // 2
    head, tail = text[:half], text[-half:]
    dropped = len(text) - len(head) - len(tail)
    truncated = f"{head}\n…{dropped} chars truncated…\n{tail}"
    lines_dropped = text.count("\n") - head.count("\n") - tail.count("\n")
    return truncated, max(lines_dropped, 0)


def formatted(exit_code, wall_seconds, output):
    body, dropped_lines = middle_truncate(output)
    total_lines = f"Total output lines: {output.count(chr(10)) + 1}\n" if dropped_lines else ""
    return (
        f"Exit code: {exit_code}\n"
        f"Wall time: {wall_seconds:.1f} seconds\n"
        f"{total_lines}"
        f"Output:\n{body}"
    )


HEREDOC = re.compile(
    r"^\s*(?:apply_patch|applypatch)\s*<<\s*['\"]?(\w+)['\"]?\s*\n(.*)\n\1\s*$",
    re.DOTALL,
)


def extract_apply_patch(command):
    """The patch, when the command is apply_patch rather than shell work.

    Codex recognizes `apply_patch <<'EOF' ... EOF` heredocs and the two-word
    `apply_patch "<patch>"` form, and routes both to the patch engine instead
    of the shell.
    """
    stripped = command.strip()
    if not stripped.startswith(("apply_patch", "applypatch")):
        return None
    match = HEREDOC.match(command)
    if match:
        return match.group(2)
    try:
        words = shlex.split(stripped)
    except ValueError:
        return None
    if len(words) == 2 and words[0] in ("apply_patch", "applypatch"):
        return words[1]
    return None


def delegate_apply_patch(patch, env):
    """Run the sibling apply_patch tool and relay its JSON answer."""
    sibling = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apply_patch.py")
    if os.path.isfile(sibling):
        argv = [sys.executable, sibling]
    else:
        on_path = shutil.which("apply_patch", path=env.get("PATH", ""))
        if not on_path:
            emit({"error": "apply_patch is not available to delegate to"})
            return
        argv = [on_path]
    result = subprocess.run(
        argv,
        input=json.dumps({"input": patch}),
        capture_output=True,
        text=True,
        env=env,
    )
    try:
        emit(json.loads(result.stdout))
    except ValueError:
        emit({"error": f"apply_patch produced no answer: {result.stderr.strip()}"})


def run():
    try:
        data = json.load(sys.stdin)
    except ValueError as err:
        emit({"error": f"invalid tool input: {err}"})
        return

    command = data.get("command")
    if not isinstance(command, str) or not command.strip():
        emit({"error": "no command provided"})
        return

    sandbox = data.get("sandbox_permissions") or "use_default"
    justification = data.get("justification") or ""
    if justification and sandbox != "require_escalated":
        # Codex rejects a justification without the override it justifies.
        emit({"error": 'justification is only used with sandbox_permissions: "require_escalated"'})
        return

    env = dict(os.environ)
    env["PATH"] = runtime_path(env)

    patch = extract_apply_patch(command)
    if patch is not None:
        delegate_apply_patch(patch, env)
        return

    workspace = env.get("HEDDLE_WORKSPACE") or os.getcwd()
    workdir = data.get("workdir") or workspace
    workdir = os.path.expanduser(os.path.expandvars(workdir))
    if not os.path.isabs(workdir):
        workdir = os.path.join(workspace, workdir)
    if not os.path.isdir(workdir):
        emit({"error": f"workdir does not exist: {workdir}"})
        return

    try:
        timeout_ms = int(data.get("timeout_ms") or DEFAULT_TIMEOUT_MS)
    except (TypeError, ValueError):
        timeout_ms = DEFAULT_TIMEOUT_MS
    timeout_ms = max(timeout_ms, 1)

    shell = shutil.which("bash", path=env["PATH"]) or "/bin/sh"
    login_flag = "-lc" if shell.endswith("bash") else "-c"

    started = time.monotonic()
    try:
        child = subprocess.Popen(
            [shell, login_flag, command],
            cwd=workdir,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,  # Codex aggregates the two streams
            start_new_session=True,
        )
    except OSError as err:
        emit({"error": f"failed to run command: {err}"})
        return

    timed_out = False
    try:
        raw, _ = child.communicate(timeout=timeout_ms / 1000)
        exit_code = child.returncode
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(os.getpgid(child.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            child.kill()
        raw, _ = child.communicate()
        exit_code = 124  # Codex's EXEC_TIMEOUT_EXIT_CODE

    wall = time.monotonic() - started
    output = (raw or b"")[:RAW_CAP].decode("utf-8", "replace")
    if timed_out:
        output = f"command timed out after {timeout_ms} milliseconds\n{output}"

    emit({"output": formatted(exit_code, wall, output)})


try:
    run()
except Exception as err:  # a crash must still read as a failed command
    emit({"error": f"shell_command error: {err}"})
