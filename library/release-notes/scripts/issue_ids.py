#!/usr/bin/env python3
"""issue_ids.py — pull ticket references out of commit subjects.

Also older than this agent. It reads the output of changes_since.sh on stdin,
which is why the shim pipes one into the other rather than reimplementing it.

    ./changes_since.sh --since v1.4.0 | ./issue_ids.py --prefix ENG
"""

import argparse
import re
import sys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default="ENG", help="ticket prefix, e.g. ENG")
    parser.add_argument("--count", action="store_true", help="print counts too")
    args = parser.parse_args()

    pattern = re.compile(rf"\b{re.escape(args.prefix)}-\d+\b")
    seen: dict[str, int] = {}

    for line in sys.stdin:
        for ticket in pattern.findall(line):
            seen[ticket] = seen.get(ticket, 0) + 1

    if not seen:
        print(f"no {args.prefix}- tickets referenced", file=sys.stderr)
        return 1

    for ticket, count in sorted(seen.items()):
        print(f"{ticket}\t{count}" if args.count else ticket)
    return 0


if __name__ == "__main__":
    sys.exit(main())
