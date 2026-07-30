#!/usr/bin/env python3

import json
import os
import shutil
import sys

DEFAULT_OUTPUT_DIR = "heddle-out"

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
