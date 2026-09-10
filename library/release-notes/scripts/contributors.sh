#!/usr/bin/env bash
# contributors.sh — who committed in a range, most first.
set -euo pipefail

SINCE=""
UNTIL="HEAD"
REPO="."

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --repo)  REPO="$2";  shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SINCE" ] || { echo "--since is required" >&2; exit 2; }

git -C "$REPO" shortlog -sn --no-merges "$SINCE..$UNTIL"
