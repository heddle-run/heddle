#!/usr/bin/env python3
"""A heddle tool: JSON object on stdin, one JSON object on stdout.

The name heddle matches is the filename without the extension — `runbook_lookup`.
Anything written to stderr is ignored by the runtime, so it is the place for
diagnostics; stdout must be JSON and nothing else.
"""
import json
import sys

RUNBOOKS = {
    "checkout-api": (
        "1. Check the pod's readiness probe: kubectl -n prod get pods -l app=checkout-api\n"
        "2. If probes fail, roll back the last deploy: kubectl -n prod rollout undo deploy/checkout-api\n"
        "3. Page the payments on-call if error rate stays above 2% for 10 minutes."
    ),
    "search-indexer": (
        "1. Confirm the queue depth: redis-cli -n 3 llen index:queue\n"
        "2. Drain with the batch worker before restarting the indexer.\n"
        "3. A restart loses in-flight batches; they are replayed from the WAL."
    ),
}


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError) as err:
        # An error *field* is not a failed tool call: the model reads it and can
        # react. Exit non-zero only when the call itself could not be made.
        print(json.dumps({"found": False, "runbook": "", "error": f"bad input: {err}"}))
        return 0

    service = str(request.get("service", "")).strip()
    runbook = RUNBOOKS.get(service)

    print(
        json.dumps(
            {
                "found": runbook is not None,
                "runbook": runbook
                or f"no runbook for {service!r}. Known services: "
                + ", ".join(sorted(RUNBOOKS)),
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
