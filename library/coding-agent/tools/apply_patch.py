#!/usr/bin/env python3
"""Codex's apply_patch: the whole grammar, applied to the workspace.

The grammar is the one in codex-rs/core/src/tools/handlers/apply_patch.lark:

    *** Begin Patch
    *** Add File: path        followed by +lines
    *** Delete File: path
    *** Update File: path     optionally *** Move to: newpath, then chunks of
                              @@ anchors and ' '/'-'/'+' lines, optionally
                              closed by *** End of File
    *** End Patch

Codex parses leniently (trailing whitespace, a stray heredoc wrapper) and
locates each chunk with three passes — exact, then ignoring trailing
whitespace, then ignoring surrounding whitespace. So does this. Success is
answered the way Codex answers it: the "Exit code: / Wall time: / Output:"
block around "Success. Updated the following files:".
"""

import json
import os
import sys


def emit(obj):
    json.dump(obj, sys.stdout)


class PatchError(Exception):
    pass


# ---------------------------------------------------------------- parsing

BEGIN = "*** Begin Patch"
END = "*** End Patch"
ADD = "*** Add File: "
DELETE = "*** Delete File: "
UPDATE = "*** Update File: "
MOVE = "*** Move to: "
EOF_MARK = "*** End of File"


def strip_heredoc(lines):
    """Tolerate `apply_patch <<'EOF' ... EOF` pasted whole, as Codex does."""
    if lines and "<<" in lines[0] and "apply_patch" in lines[0]:
        lines = lines[1:]
        if lines and lines[-1].strip() in ("EOF", "'EOF'", '"EOF"', "PATCH"):
            lines = lines[:-1]
    return lines


def parse_patch(text):
    """The patch as a list of operations, or a PatchError saying what is wrong."""
    if not isinstance(text, str) or not text.strip():
        raise PatchError("the patch is empty")

    lines = strip_heredoc(text.splitlines())
    lines = [line.rstrip("\r") for line in lines]
    while lines and not lines[0].strip():
        lines = lines[1:]
    while lines and not lines[-1].strip():
        lines = lines[:-1]

    if not lines or lines[0].strip() != BEGIN:
        raise PatchError(f'the first line of the patch must be "{BEGIN}"')
    if lines[-1].strip() != END:
        raise PatchError(f'the last line of the patch must be "{END}"')

    body = lines[1:-1]
    ops = []
    index = 0
    while index < len(body):
        line = body[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped.startswith(ADD.strip()) and line.startswith(ADD):
            path = line[len(ADD):].strip()
            index += 1
            added = []
            while index < len(body) and not body[index].startswith("*** "):
                content = body[index]
                if not content.startswith("+"):
                    raise PatchError(
                        f"Add File {path}: every line of a new file starts "
                        f"with '+', got {content!r}"
                    )
                added.append(content[1:])
                index += 1
            ops.append({"kind": "add", "path": path, "lines": added})
        elif stripped.startswith(DELETE.strip()) and line.startswith(DELETE):
            ops.append({"kind": "delete", "path": line[len(DELETE):].strip()})
            index += 1
        elif stripped.startswith(UPDATE.strip()) and line.startswith(UPDATE):
            path = line[len(UPDATE):].strip()
            index += 1
            move_to = None
            if index < len(body) and body[index].startswith(MOVE):
                move_to = body[index][len(MOVE):].strip()
                index += 1
            chunks, index = parse_chunks(body, index, path)
            ops.append(
                {"kind": "update", "path": path, "move_to": move_to,
                 "chunks": chunks}
            )
        else:
            raise PatchError(f"unexpected line in patch: {line!r}")

    if not ops:
        raise PatchError("the patch contains no operations")

    seen = set()
    for op in ops:
        if op["path"] in seen:
            raise PatchError(f"{op['path']} appears more than once in the patch")
        seen.add(op["path"])
    return ops


def parse_chunks(body, index, path):
    """The chunks of one Update File hunk: anchors, then old/new line pairs."""
    chunks = []
    current = None

    def close():
        nonlocal current
        if current is not None:
            if not current["old"] and not current["new"]:
                raise PatchError(f"Update File {path}: a chunk has no lines")
            chunks.append(current)
            current = None

    def ensure():
        nonlocal current
        if current is None:
            current = {"anchor": None, "old": [], "new": [], "at_eof": False}

    while index < len(body):
        line = body[index]
        if line.startswith("*** ") and line.strip() != EOF_MARK:
            break
        if line.strip() == EOF_MARK:
            ensure()
            current["at_eof"] = True
            index += 1
            close()
            continue
        if line == "@@" or line.startswith("@@ "):
            close()
            ensure()
            anchor = line[3:] if line.startswith("@@ ") else None
            current["anchor"] = anchor
            index += 1
            continue
        if line.startswith(" ") or line == "":
            ensure()
            content = line[1:] if line.startswith(" ") else ""
            current["old"].append(content)
            current["new"].append(content)
        elif line.startswith("-"):
            ensure()
            current["old"].append(line[1:])
        elif line.startswith("+"):
            ensure()
            current["new"].append(line[1:])
        else:
            raise PatchError(
                f"Update File {path}: a chunk line starts with ' ', '-', "
                f"'+', '@@' or '***', got {line!r}"
            )
        index += 1

    close()
    if not chunks:
        raise PatchError(f"Update File {path}: no chunks to apply")
    return chunks, index


# ---------------------------------------------------------------- applying

def seek(haystack, needle, start):
    """Codex's three matching passes: exact, rstrip, then strip."""
    for canon in (
        lambda s: s,
        lambda s: s.rstrip(),
        lambda s: s.strip(),
    ):
        wanted = [canon(line) for line in needle]
        for at in range(start, len(haystack) - len(needle) + 1):
            if [canon(line) for line in haystack[at:at + len(needle)]] == wanted:
                return at
    return -1


def seek_anchor(haystack, anchor, start):
    for canon in (lambda s: s, lambda s: s.rstrip(), lambda s: s.strip()):
        wanted = canon(anchor)
        for at in range(start, len(haystack)):
            if canon(haystack[at]) == wanted:
                return at
    return -1


def apply_update(path, original, chunks):
    lines = original.split("\n")
    position = 0
    for chunk in chunks:
        if chunk["anchor"] is not None:
            found = seek_anchor(lines, chunk["anchor"], position)
            if found < 0:
                raise PatchError(
                    f"{path}: could not find the @@ anchor {chunk['anchor']!r}"
                )
            position = found + 1
        old = chunk["old"]
        if chunk["at_eof"] and len(lines) >= len(old):
            at = len(lines) - len(old)
            if seek(lines[at:], old, 0) != 0:
                at = -1
        else:
            at = seek(lines, old, position)
        if at < 0:
            wanted = "\n".join(old[:3])
            raise PatchError(
                f"{path}: could not find the lines to replace, starting "
                f"with:\n{wanted}"
            )
        lines[at:at + len(old)] = chunk["new"]
        position = at + len(chunk["new"])
    return "\n".join(lines)


def resolve(workspace, path):
    """The path inside the workspace, or a refusal — Codex's writable roots."""
    if not path or path.strip() != path:
        raise PatchError(f"bad path in patch: {path!r}")
    if os.path.isabs(path):
        raise PatchError(
            f"{path}: absolute paths are not allowed; every path is relative "
            f"to the workspace root"
        )
    full = os.path.realpath(os.path.join(workspace, path))
    root = os.path.realpath(workspace)
    if full != root and not full.startswith(root + os.sep):
        raise PatchError(f"{path}: writes outside of the workspace are not allowed")
    return full


def apply_ops(workspace, ops):
    """Verify everything first, then write — Codex verifies before applying."""
    planned = []
    for op in ops:
        full = resolve(workspace, op["path"])
        if op["kind"] == "add":
            if os.path.exists(full):
                raise PatchError(f"Add File {op['path']}: the file already exists")
            planned.append(("A", op["path"], full, "\n".join(op["lines"]) + "\n", None))
        elif op["kind"] == "delete":
            if not os.path.isfile(full):
                raise PatchError(f"Delete File {op['path']}: the file does not exist")
            planned.append(("D", op["path"], full, None, None))
        else:
            if not os.path.isfile(full):
                raise PatchError(f"Update File {op['path']}: the file does not exist")
            with open(full, encoding="utf-8", errors="replace") as handle:
                original = handle.read()
            updated = apply_update(op["path"], original, op["chunks"])
            dest = full
            shown = op["path"]
            if op["move_to"]:
                dest = resolve(workspace, op["move_to"])
                shown = f"{op['path']} -> {op['move_to']}"
            planned.append(("M", shown, full, updated, dest))

    changed = []
    for mark, shown, full, content, dest in planned:
        if mark == "A":
            os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
            with open(full, "w", encoding="utf-8") as handle:
                handle.write(content)
        elif mark == "D":
            os.remove(full)
        else:
            target = dest or full
            os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
            with open(target, "w", encoding="utf-8") as handle:
                handle.write(content)
            if target != full:
                os.remove(full)
        changed.append(f"{mark} {shown}")
    return changed


def run():
    try:
        data = json.load(sys.stdin)
    except ValueError as err:
        emit({"error": f"invalid tool input: {err}"})
        return

    patch = data.get("input")
    workspace = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()

    try:
        ops = parse_patch(patch if isinstance(patch, str) else "")
        changed = apply_ops(workspace, ops)
    except PatchError as err:
        emit({"error": f"apply_patch verification failed: {err}"})
        return

    listing = "\n".join(changed)
    emit({
        "output": (
            "Exit code: 0\n"
            "Wall time: 0.0 seconds\n"
            "Output:\n"
            f"Success. Updated the following files:\n{listing}"
        )
    })


try:
    run()
except Exception as err:  # a crash must still read as a failed call
    emit({"error": f"apply_patch error: {err}"})
