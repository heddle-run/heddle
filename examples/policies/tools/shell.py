#!/usr/bin/env python3
"""A stand-in for a real shell tool. It reports the command rather than running
it, so the interesting thing about this example stays the policy that refused it.
"""

import json
import sys


def main() -> int:
    request = json.loads(sys.stdin.read() or "{}")
    print(json.dumps({"stdout": f"would have run: {request.get('cmd', '')}"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
