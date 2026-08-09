#!/usr/bin/env python3
"""Codex's update_plan tool: record the plan, return "Plan updated".

Codex keeps the plan as session state and shows it in the UI; the model only
ever reads back the two words. Here the plan lands in a dotfile at the
workspace root, so a later call (or a curious human) can read where the task
stands, and the model reads the same acknowledgement Codex answers with.
"""

import json
import os
import sys

STATUSES = ("pending", "in_progress", "completed")


def emit(obj):
    json.dump(obj, sys.stdout)


def fail(reason):
    emit({"error": reason})


def run():
    try:
        data = json.load(sys.stdin)
    except ValueError as err:
        fail(f"invalid tool input: {err}")
        return

    plan = data.get("plan")
    if not isinstance(plan, list) or not plan:
        fail("plan must be a non-empty array of {step, status} items")
        return

    steps = []
    in_progress = 0
    for index, item in enumerate(plan):
        if not isinstance(item, dict):
            fail(f"plan[{index}] is not an object")
            return
        step = item.get("step")
        status = item.get("status")
        if not isinstance(step, str) or not step.strip():
            fail(f"plan[{index}].step must be a non-empty string")
            return
        if status not in STATUSES:
            fail(
                f"plan[{index}].status is {status!r}; it must be one of "
                f"{', '.join(STATUSES)}"
            )
            return
        if status == "in_progress":
            in_progress += 1
        steps.append({"step": step.strip(), "status": status})

    if in_progress > 1:
        fail("at most one step can be in_progress at a time")
        return

    record = {"plan": steps}
    explanation = data.get("explanation")
    if isinstance(explanation, str) and explanation.strip():
        record["explanation"] = explanation.strip()

    workspace = os.environ.get("HEDDLE_WORKSPACE") or os.getcwd()
    try:
        with open(os.path.join(workspace, ".agent-plan.json"), "w") as handle:
            json.dump(record, handle, indent=2)
    except OSError:
        pass  # the acknowledgement, not the file, is the contract

    emit({"output": "Plan updated"})


try:
    run()
except Exception as err:  # a crash must still read as a failed call
    fail(f"update_plan error: {err}")
