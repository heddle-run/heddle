#!/usr/bin/env python3
"""One body, by the name list_skills gave."""
import json, os, pathlib, sys

data = json.load(sys.stdin)
asked = str(data.get("name") or "").strip().lower()

root = pathlib.Path(os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()) / "skills"
path = root / ("%s.md" % asked)

# Refused rather than trusted: the name arrives from the model, and "../../etc"
# is a path this would otherwise open.
inside = asked and path.parent.resolve() == root.resolve()

if inside and path.is_file():
    body = path.read_text()
else:
    # Answered, not thrown. A tool that fails takes the round with it, and the
    # model that mistyped the name is the one reader who can correct it.
    names = ", ".join(sorted(p.stem for p in root.glob("*.md")))
    body = 'there is no skill called "%s". There are: %s.' % (asked, names)

json.dump({"body": body}, sys.stdout)
