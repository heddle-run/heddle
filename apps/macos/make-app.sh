#!/bin/bash
# Assemble Heddle.app from the Swift release binary and a self-contained
# heddle CLI, so the app runs on a machine with neither Node nor heddle
# installed.
#
#   apps/macos/make-app.sh [output-dir]     (default: apps/macos/build)
#
# What goes in:
#   Contents/MacOS/Heddle                     swift build -c release
#   Contents/Resources/heddle-runtime/node    this machine's node binary
#   Contents/Resources/heddle-runtime/cli/    pnpm deploy --prod of @heddle-run/cli
#   Contents/Info.plist                       LSUIElement menu bar app
#
# The signature is ad-hoc: enough to run locally and in CI. Developer ID
# signing and notarization replace the last step for distribution.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$HERE/build}"
APP="$OUT/Heddle.app"

VERSION="$(node -p "require('$REPO/package.json').version.split('-')[0]")"

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
cp "$(command -v node)" "$APP/Contents/Resources/heddle-runtime/node"
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
