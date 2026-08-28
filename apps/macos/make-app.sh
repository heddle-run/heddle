#!/bin/bash
# Assemble Heddle.app from the Swift release binary and a self-contained
# heddle CLI, so the app runs on a machine with neither Node nor heddle
# installed.
#
#   apps/macos/make-app.sh [--universal | --system-node] [output-dir]
#                                           (default: apps/macos/build)
#
# What goes in:
#   Contents/MacOS/Heddle                     swift build -c release
#   Contents/Resources/heddle-runtime/node    a pinned official Node build
#   Contents/Resources/heddle-runtime/cli/    pnpm deploy --prod of @heddle-run/cli
#   Contents/Info.plist                       LSUIElement menu bar app
#
# The node is downloaded from nodejs.org at the exact NODE_VERSION below and
# checked against the release's SHASUMS256.txt, so two machines assembling
# this commit pack the same runtime — the builder's own nvm is not an input.
# --universal packs arm64 + x86_64 lipo'd together (roughly doubles the
# runtime's size); the default is the build machine's architecture.
# --system-node keeps the old behaviour — whatever `node` is on PATH — for
# offline development only.
#
# The signature is ad-hoc: enough to run locally and in CI. Developer ID
# signing and notarization replace the last step for distribution.

set -euo pipefail

# The runtime every release of the app ships. Bump deliberately, alongside a
# run of the app's tests — this is a dependency pin, not a convenience.
NODE_VERSION="22.23.2"

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

UNIVERSAL=0
SYSTEM_NODE=0
OUT="$HERE/build"
for arg in "$@"; do
    case "$arg" in
        --universal) UNIVERSAL=1 ;;
        --system-node) SYSTEM_NODE=1 ;;
        *) OUT="$arg" ;;
    esac
done
APP="$OUT/Heddle.app"

VERSION="$(node -p "require('$REPO/package.json').version.split('-')[0]")"

# One pinned-and-verified `bin/node`, extracted into the cache; prints its
# path. The cache keys on version and architecture, so switching either
# re-fetches and nothing is ever half-reused.
fetch_node() {
    local arch="$1"
    local name="node-v$NODE_VERSION-darwin-$arch"
    local cache="$HERE/.node-cache/$name"

    if [ ! -x "$cache/node" ]; then
        echo "==> fetching $name from nodejs.org" >&2
        mkdir -p "$cache"
        local base="https://nodejs.org/dist/v$NODE_VERSION"
        curl -fsSL -o "$cache/$name.tar.gz" "$base/$name.tar.gz"
        curl -fsSL -o "$cache/SHASUMS256.txt" "$base/SHASUMS256.txt"
        (cd "$cache" && grep " $name.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c - >&2)
        tar -xzf "$cache/$name.tar.gz" -C "$cache" --strip-components=2 "$name/bin/node"
        rm "$cache/$name.tar.gz"
    fi
    echo "$cache/node"
}

echo "==> swift build -c release"
swift build -c release --package-path "$HERE"
BINARY="$(swift build -c release --package-path "$HERE" --show-bin-path)/Heddle"

echo "==> pnpm deploy @heddle-run/cli (production, self-contained)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# --legacy: the workspace does not use injected dependencies, and the
# non-legacy deploy refuses to run without them (pnpm >= 10).
(cd "$REPO" && pnpm --filter @heddle-run/cli deploy --prod --legacy "$STAGE/cli" >/dev/null)

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/heddle-runtime"

cp "$BINARY" "$APP/Contents/MacOS/Heddle"

PACKED_NODE="$APP/Contents/Resources/heddle-runtime/node"

pack_node() {
    if [ "$SYSTEM_NODE" = 1 ]; then
        cp "$(command -v node)" "$PACKED_NODE"
    elif [ "$UNIVERSAL" = 1 ]; then
        lipo -create "$(fetch_node arm64)" "$(fetch_node x64)" -output "$PACKED_NODE"
    else
        case "$(uname -m)" in
            arm64) cp "$(fetch_node arm64)" "$PACKED_NODE" ;;
            *) cp "$(fetch_node x64)" "$PACKED_NODE" ;;
        esac
    fi
    chmod 755 "$PACKED_NODE"
}

pack_node
# Debug symbols are for a crash the app would never symbolicate; -x keeps
# the exported symbols Node's own native-addon loading needs, and shaves
# ~20% off the runtime. Stripping invalidates the existing signature — on
# arm64 macOS kills an invalidated binary outright — so it is re-signed
# ad-hoc before the proof-by-running, and repacked whole if that fails.
strip -x "$PACKED_NODE" 2>/dev/null || true
codesign --force --sign - "$PACKED_NODE" 2>/dev/null || true
if ! "$PACKED_NODE" -e "process.exit(0)" 2>/dev/null; then
    echo "==> stripped node does not run; repacking unstripped" >&2
    pack_node
fi

cp -R "$STAGE/cli" "$APP/Contents/Resources/heddle-runtime/cli"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>Heddle</string>
    <key>CFBundleIdentifier</key>
    <string>run.heddle.app</string>
    <key>CFBundleName</key>
    <string>Heddle</string>
    <key>CFBundleDisplayName</key>
    <string>Heddle</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>$VERSION</string>
    <key>CFBundleVersion</key>
    <string>$VERSION</string>
    <key>LSMinimumSystemVersion</key>
    <string>14.0</string>
    <key>LSUIElement</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>MIT license — https://github.com/heddle-run/heddle</string>
    <key>UTExportedTypeDeclarations</key>
    <array>
        <dict>
            <key>UTTypeIdentifier</key>
            <string>run.heddle.bundle</string>
            <key>UTTypeDescription</key>
            <string>Heddle agent bundle</string>
            <key>UTTypeConformsTo</key>
            <array>
                <!-- A gzipped tar, so data rather than any archive UTI:
                     conforming to public.zip-archive or friends would invite
                     Archive Utility to claim double-click. -->
                <string>public.data</string>
            </array>
            <key>UTTypeTagSpecification</key>
            <dict>
                <key>public.filename-extension</key>
                <array>
                    <string>heddle</string>
                </array>
            </dict>
        </dict>
    </array>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>run.heddle.app.url</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>heddle</string>
            </array>
        </dict>
    </array>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>Heddle agent bundle</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>LSHandlerRank</key>
            <string>Owner</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>run.heddle.bundle</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
PLIST

echo "==> codesign (ad-hoc)"
codesign --force --sign - "$APP/Contents/Resources/heddle-runtime/node"
codesign --force --sign - "$APP"

echo "==> done: $APP"
du -sh "$APP" | awk '{print "    " $1}'
