#!/usr/bin/env python3
"""Read a file from the workspace, by a path relative to it."""
import json, os, sys

data = json.load(sys.stdin)
path = (data.get("path") or "").strip()

root = os.path.realpath(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd())
target = os.path.realpath(os.path.join(root, path))
inside = path and (target == root or target.startswith(root + os.sep))

if not inside:
    json.dump({"content": "refused: path must stay inside the workspace"}, sys.stdout)
    sys.exit(0)

try:
    with open(target) as handle:
        content = handle.read()[:8000]
except OSError as err:
    # A message rather than a crash: the model picked this path and can pick
    # another once it is told.
    content = "could not read %s: %s" % (path, err)

json.dump({"content": content}, sys.stdout)
