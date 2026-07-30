#!/usr/bin/env python3
import json
import sys
import glob
import re
import os

data = json.load(sys.stdin)
base_path = data.get("path", ".")
pattern = data.get("pattern", "")
content_pattern = data.get("content_pattern", "")

if not pattern and not content_pattern:
    json.dump(
        {"results": "Error: provide at least one of 'pattern' or 'content_pattern'"},
        sys.stdout,
    )
    sys.exit(0)

try:
    if pattern:
        search_pattern = os.path.join(base_path, pattern)
        files = sorted(glob.glob(search_pattern, recursive=True))
    else:
        files = []
        skip_dirs = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}
        for root, dirs, filenames in os.walk(base_path):
            dirs[:] = [d for d in dirs if d not in skip_dirs and not d.startswith(".")]
            for fname in filenames:
                files.append(os.path.join(root, fname))

    if content_pattern:
        regex = re.compile(content_pattern)
        matches = []
        for fpath in files[:500]:
            if os.path.isdir(fpath):
                continue
            try:
                with open(fpath, "r", errors="ignore") as f:
                    for i, line in enumerate(f, 1):
                        if regex.search(line):
                            matches.append(f"{fpath}:{i}: {line.rstrip()}")
                            if len(matches) >= 100:
                                break
            except (PermissionError, IsADirectoryError):
                continue
            if len(matches) >= 100:
                break
        result = "\n".join(matches) if matches else "No matches found"
    else:
        files = [f for f in files if not os.path.isdir(f)]
        result = "\n".join(files)[:200] if files else "No files found"

    json.dump({"results": result}, sys.stdout)

except Exception as e:
    json.dump({"results": f"Error: {e}"}, sys.stdout)
