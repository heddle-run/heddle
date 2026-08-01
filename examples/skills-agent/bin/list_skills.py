#!/usr/bin/env python3
"""The index, and only the index.

A skill's first line is its description: when it applies, in one sentence. That
line is what the model carries all the time, and the body is what a second tool
call costs. Sending the bodies from here would put every skill in the
conversation on the first call, which is the whole thing this arrangement
avoids.
"""
import json, os, pathlib, sys

json.load(sys.stdin)

# The workspace, not the working directory -- they are the same today, and
# saying which one is meant survives a tool being called from somewhere else.
root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"

index = "\n".join(
    "%s: %s" % (path.stem, path.read_text().splitlines()[0])
    for path in sorted(root.glob("*.md"))
)

json.dump({"skills": index or "there are no skills here"}, sys.stdout)
