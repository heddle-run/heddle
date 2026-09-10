#!/usr/bin/env bash
# changes_since.sh — commits since a tag, one per line.
#
# Written in 2023, long before anybody here had heard of an agent. Flags in,
# text out, exits non-zero when it cannot do the job. Nothing about it has been
# changed to make it work with heddle; see ../tools/changes_since.sh for the
# shim that makes it a tool.
#
#   ./changes_since.sh --since v1.4.0 [--until HEAD] [--repo .]
set -euo pipefail

SINCE=""
UNTIL="HEAD"
REPO="."

while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --until) UNTIL="$2"; shift 2 ;;
    --repo)  REPO="$2";  shift 2 ;;
    -h|--help)
      echo "usage: $0 --since <tag> [--until <ref>] [--repo <dir>]" >&2
      exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$SINCE" ]; then
  echo "--since is required" >&2
  exit 2
fi

git -C "$REPO" log --no-merges --pretty=format:'%h%x09%an%x09%s' "$SINCE..$UNTIL"
