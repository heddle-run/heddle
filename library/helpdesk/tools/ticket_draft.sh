#!/usr/bin/env bash
# Write a ticket into the workspace for a human to pick up.
#
# Nothing here talks to a ticketing system. That is deliberate: the bundle runs
# on a laptop with no credentials, and a file the recipient can read, edit and
# paste is the version that works everywhere. Swap this script for one that
# POSTs to Jira and nothing else about the agent changes.
set -euo pipefail

SCRIPT=$(cat <<'PY'
import datetime
import json
import os
import re
import sys


def fail(message):
    print(json.dumps({"ticket_id": "", "path": "", "error": message}))
    raise SystemExit(0)


try:
    request = json.load(sys.stdin)
except (json.JSONDecodeError, ValueError) as err:
    fail(f"bad input: {err}")

summary = str(request.get("summary", "")).strip()
detail = str(request.get("detail", "")).strip()
requester = str(request.get("requester", "unknown") or "unknown").strip()
urgency = str(request.get("urgency", "normal") or "normal").strip().lower()
if not summary:
    fail("summary is required")
if urgency not in {"low", "normal", "high"}:
    urgency = "normal"

root = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()
tickets = os.path.join(root, "tickets")
os.makedirs(tickets, exist_ok=True)

stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
slug = re.sub(r"[^a-z0-9]+", "-", summary.lower()).strip("-")[:40] or "request"
ticket_id = f"IT-{stamp}"
path = os.path.join(tickets, f"{ticket_id}-{slug}.md")

body = (
    f"# {summary}\n\n"
    f"- **Ticket:** {ticket_id}\n"
    f"- **Requester:** {requester}\n"
    f"- **Urgency:** {urgency}\n"
    f"- **Raised:** {datetime.datetime.now().isoformat(timespec='seconds')}\n"
    f"- **Raised by:** the helpdesk agent, because the handbook does not cover this\n\n"
    f"## What was asked\n\n{detail}\n"
)

try:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(body)
except OSError as err:
    fail(f"cannot write the ticket: {err}")

print(json.dumps({"ticket_id": ticket_id, "path": path, "urgency": urgency}))
PY
)

python3 -c "$SCRIPT"
