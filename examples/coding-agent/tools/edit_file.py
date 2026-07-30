#!/usr/bin/env python3
import json
import sys

data = json.load(sys.stdin)
path = data.get("path", "")
old_string = data.get("old_string", "")
new_string = data.get("new_string", "")

if not path:
    json.dump({"result": "Error: no path provided"}, sys.stdout)
    sys.exit(0)

try:
    with open(path, "r") as f:
        content = f.read()
except FileNotFoundError:
    json.dump({"result": f"Error: file not found: {path}"}, sys.stdout)
    sys.exit(0)
except Exception as e:
    json.dump({"result": f"Error reading file: {e}"}, sys.stdout)
    sys.exit(0)

if not old_string:
    content = content + new_string
    with open(path, "w") as f:
        f.write(content)
    json.dump({"result": f"Successfully appended to {path}"}, sys.stdout)
    sys.exit(0)

if old_string not in content:
    json.dump(
        {
            "result": f"Error: old_string not found in {path}. "
            "Make sure it matches exactly, including whitespace and indentation."
        },
        sys.stdout,
    )
    sys.exit(0)

count = content.count(old_string)
new_content = content.replace(old_string, new_string, 1)

try:
    with open(path, "w") as f:
        f.write(new_content)
    msg = f"Successfully edited {path}"
    if count > 1:
        msg += f" (replaced first of {count} occurrences)"
    json.dump({"result": msg}, sys.stdout)
except Exception as e:
    json.dump({"result": f"Error writing to file: {e}"}, sys.stdout)