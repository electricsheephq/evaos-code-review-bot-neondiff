#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="NeonDiffDesktop"
BUNDLE_ID="com.electricsheephq.NeonDiffDesktop"
MIN_SYSTEM_VERSION="14.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# preflight: run the credential doctor (reports signing/notarization/Sparkle
# credential presence) and exit before any build. Additive, read-only mode —
# it mutates nothing and does not touch the default run/build behavior below.
if [ "$MODE" = "preflight" ] || [ "$MODE" = "--preflight" ]; then
  exec "$SCRIPT_DIR/preflight-credentials.sh" "${@:2}"
fi

DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_FRAMEWORKS="$APP_CONTENTS/Frameworks"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
SHORT_VERSION="${NEONDIFF_DESKTOP_VERSION:-0.1.0}"
BUILD_VERSION="${NEONDIFF_DESKTOP_BUILD:-1}"
SPARKLE_FEED_URL="${NEONDIFF_SPARKLE_FEED_URL:-}"
SPARKLE_PUBLIC_KEY="${NEONDIFF_SPARKLE_PUBLIC_ED_KEY:-}"

if [ -x "$APP_BINARY" ]; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    proc_path="$(/bin/ps -p "$pid" -o comm= 2>/dev/null || true)"
    if [ "$proc_path" = "$APP_BINARY" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < <(pgrep -x "$APP_NAME" 2>/dev/null || true)
fi

cd "$ROOT_DIR"
swift build --product "$APP_NAME"
BUILD_DIR="$(swift build --show-bin-path)"
BUILD_BINARY="$BUILD_DIR/$APP_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"

RESOURCE_DIR="$(find "$BUILD_DIR" "$ROOT_DIR/.build" \( -name "${APP_NAME}_${APP_NAME}.bundle" -o -name "${APP_NAME}_${APP_NAME}.resources" \) -type d -print -quit 2>/dev/null || true)"
if [ -n "$RESOURCE_DIR" ]; then
  ditto "$RESOURCE_DIR" "$APP_BUNDLE/$(basename "$RESOURCE_DIR")"
  ditto "$RESOURCE_DIR" "$APP_RESOURCES/$(basename "$RESOURCE_DIR")"
fi

if [ -f "$ROOT_DIR/THIRD_PARTY_NOTICES.md" ]; then
  cp "$ROOT_DIR/THIRD_PARTY_NOTICES.md" "$APP_RESOURCES/THIRD_PARTY_NOTICES.md"
fi

SPARKLE_FRAMEWORK="$(find "$BUILD_DIR" "$ROOT_DIR/.build" -path "*/Sparkle.framework" -type d -print -quit 2>/dev/null || true)"
if otool -L "$APP_BINARY" | grep -q "Sparkle.framework"; then
  if [ -z "$SPARKLE_FRAMEWORK" ]; then
    echo "Sparkle.framework is linked but was not found in the SwiftPM build output" >&2
    exit 1
  fi
  mkdir -p "$APP_FRAMEWORKS"
  ditto "$SPARKLE_FRAMEWORK" "$APP_FRAMEWORKS/Sparkle.framework"
  if ! otool -l "$APP_BINARY" | grep -q "@executable_path/../Frameworks"; then
    echo "Sparkle.framework is linked but $APP_BINARY is missing @executable_path/../Frameworks rpath" >&2
    exit 1
  fi
fi

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>NeonDiff Desktop</string>
  <key>CFBundleShortVersionString</key>
  <string>$SHORT_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$BUILD_VERSION</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
</dict>
</plist>
PLIST

if [ -n "$SPARKLE_FEED_URL" ] && [ -n "$SPARKLE_PUBLIC_KEY" ]; then
  /usr/libexec/PlistBuddy -c "Add :SUFeedURL string $SPARKLE_FEED_URL" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_KEY" "$INFO_PLIST"
fi

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  build)
    ;;
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 1
    pgrep -x "$APP_NAME" >/dev/null
    ;;
  --bundle-check|bundle-check)
    /usr/bin/plutil -lint "$INFO_PLIST" >/dev/null
    otool -L "$APP_BINARY"
    if otool -L "$APP_BINARY" | grep -q "Sparkle.framework"; then
      test -d "$APP_FRAMEWORKS/Sparkle.framework"
      otool -l "$APP_BINARY" | grep -q "@executable_path/../Frameworks"
    fi
    ;;
  *)
    echo "usage: $0 [build|run|--debug|--logs|--telemetry|--verify|--bundle-check|preflight]" >&2
    exit 2
    ;;
esac
