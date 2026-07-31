#!/usr/bin/env python3
"""A tool that fails the way a real dependency fails: intermittently, and with a
message that says whether coming back later would help.

It reports a timeout, which is what `RetryPolicy` is configured to retry. Set
FLAKY_MODE=fatal to get an error no retry would fix, so the other branch of the
policy — pass, or substitute — is reachable without editing anything.
"""

import json
import os
import sys

TRANSIENT = "upstream timed out after 5000ms"
FATAL = "no such record"


def main() -> int:
    sys.stdin.read()

    fatal = os.environ.get("FLAKY_MODE") == "fatal"
    sys.stderr.write(f"flaky: {FATAL if fatal else TRANSIENT}\n")
    print(json.dumps({"error": FATAL if fatal else TRANSIENT}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
