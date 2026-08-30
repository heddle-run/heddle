#!/bin/sh
# Rebuild the portable engine and copy it into the Swift package's resources.
#
# The apps build with SwiftPM and Xcode, which have no business depending on
# a Node toolchain — so the built artifact is checked in, and this script is
# how it moves. CI diffs the copy against a fresh build; when that fails,
# running this is the fix.
set -e

root="$(cd "$(dirname "$0")/.." && pwd)"

pnpm --filter @heddle-run/core build:portable

src="$root/packages/core/dist/portable/heddle-engine.js"
dest="$root/apps/HeddleCore/Sources/HeddleCore/EngineResources/heddle-engine.js"

cp "$src" "$dest"
echo "updated $dest ($(wc -c < "$dest" | tr -d ' ') bytes)"
