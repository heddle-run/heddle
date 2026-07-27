#!/usr/bin/env python3
"""present_file tool: copies a file out of the workspace so the user keeps it.

$HEDDLE_WORKSPACE is scratch. It is created when the agent starts, shared by
that agent's tool calls, and deleted when the agent finishes — so a chart the
model rendered or a report it wrote is gone by the time anyone reads the
answer. This tool is how a file survives the run.

The destination is $HEDDLE_OUTPUT_DIR, defaulting to ./heddle-out beside
wherever heddle was started. Under --safe that directory has to exist and be
granted with --allow-write; nothing else on the host is writable, which is the
point. The error below says so rather than leaving the model to guess why a
copy failed.

Only the basename of `name` is used. The model chooses that string, and a
`name` of "../../.ssh/authorized_keys" must land in the output directory like
any other file.
"""

import json
import os
import shutil
import sys

DEFAULT_OUTPUT_DIR = "heddle-out"

# A cap, not a policy: heddle kills the tool at 30s anyway, and this turns a
# runaway copy into a message the model can act on instead of a timeout.
MAX_BYTES = 50 * 1024 * 1024


def emit(**fields):
    json.dump(fields, sys.stdout)


def fail(message):
    emit(path="", bytes=0, error=message)


def output_dir():
    declared = os.environ.get("HEDDLE_OUTPUT_DIR")
    if declared:
        return os.path.abspath(declared)
    return os.path.join(os.getcwd(), DEFAULT_OUTPUT_DIR)


def unique_destination(directory, filename):
    """A second file of the same name is kept, not silently overwritten."""
    stem, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    index = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{stem}-{index}{ext}")
        index += 1
    return candidate


def run():
    try:
        data = json.load(sys.stdin)
    except ValueError as err:
        fail(f"invalid tool input: {err}")
        return

    source = (data.get("path") or "").strip()
    if not source:
        fail("no path provided")
        return

    # A model that watched itself write "$HEDDLE_WORKSPACE/report.pdf" in a shell
    # command will hand back the same string here, where no shell expands it. It
    # means what it says, so expand it — and read a bare filename as living in the
    # workspace, which is where the model was told to put things.
    source = os.path.expanduser(os.path.expandvars(source))
    if not os.path.isabs(source):
        source = os.path.join(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd(), source)
    source = os.path.abspath(source)

    if not os.path.exists(source):
        fail(f"file not found: {source}")
        return
    if os.path.isdir(source):
        fail(f"{source} is a directory; archive it into a single file first")
        return

    size = os.path.getsize(source)
    if size > MAX_BYTES:
        fail(f"file is {size} bytes, over the {MAX_BYTES} byte limit")
        return

    name = os.path.basename((data.get("name") or "").strip()) or os.path.basename(source)
    if name in (".", ".."):
        fail(f'"{name}" is not a usable file name')
        return

    directory = output_dir()
    try:
        os.makedirs(directory, exist_ok=True)
    except OSError as err:
        fail(
            f"cannot write to {directory}: {err}. Under --safe the output directory "
            f"must exist before the run and be granted with --allow-write."
        )
        return

    destination = unique_destination(directory, name)
    try:
        shutil.copyfile(source, destination)
    except OSError as err:
        fail(
            f"could not copy to {destination}: {err}. Under --safe the output "
            f"directory must be granted with --allow-write."
        )
        return

    emit(path=destination, bytes=size)


try:
    run()
except Exception as err:  # never exit non-zero: that reads as a broken tool
    fail(f"present_file tool error: {err}")
