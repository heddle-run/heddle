#!/usr/bin/env python3
"""Write a file in the workspace.

Every path is taken relative to $HEDDLE_WORKSPACE and refused if it climbs out.
Under --safe the sandbox has already made that true and this is belt and braces;
without it, this refusal is the only thing keeping a written path inside.
"""
import json, os, sys

data = json.load(sys.stdin)
path = (data.get("path") or "").strip()
content = data.get("content") or ""

root = os.path.realpath(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd())
target = os.path.realpath(os.path.join(root, path))
inside = path and (target == root or target.startswith(root + os.sep))

if not inside:
    json.dump({"result": "refused: path must stay inside the workspace"}, sys.stdout)
    sys.exit(0)

os.makedirs(os.path.dirname(target), exist_ok=True)
with open(target, "w") as handle:
    handle.write(content)

json.dump({"result": "wrote %d bytes to %s" % (len(content), path)}, sys.stdout)
