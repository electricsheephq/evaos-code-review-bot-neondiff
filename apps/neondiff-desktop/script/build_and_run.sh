#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="NeonDiff"
PRODUCT_NAME="NeonDiffDesktop"
BUNDLE_NAME="NeonDiffDesktop"
BUNDLE_ID="com.electricsheephq.NeonDiffDesktop"
MIN_SYSTEM_VERSION="14.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_CONFIGURATION="${NEONDIFF_DESKTOP_BUILD_CONFIGURATION:-debug}"
case "$MODE" in
  release-build|release-bundle-check)
    BUILD_CONFIGURATION="release"
    ;;
esac
if [ "$BUILD_CONFIGURATION" != "debug" ] && [ "$BUILD_CONFIGURATION" != "release" ]; then
  echo "NEONDIFF_DESKTOP_BUILD_CONFIGURATION must be debug or release" >&2
  exit 2
fi

# preflight: run the credential doctor (reports signing/notarization/Sparkle
# credential presence) and exit before any build. Additive, read-only mode —
# it mutates nothing and does not touch the default run/build behavior below.
if [ "$MODE" = "preflight" ] || [ "$MODE" = "--preflight" ]; then
  exec "$SCRIPT_DIR/preflight-credentials.sh" "${@:2}"
fi

DIST_DIR="${NEONDIFF_DESKTOP_DIST_DIR:-$ROOT_DIR/dist}"
APP_BUNDLE="$DIST_DIR/$BUNDLE_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_FRAMEWORKS="$APP_CONTENTS/Frameworks"
APP_HELPERS="$APP_CONTENTS/Helpers"
APP_BINARY="$APP_MACOS/$PRODUCT_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
SHORT_VERSION="${NEONDIFF_DESKTOP_VERSION:-0.1.0}"
BUILD_VERSION="${NEONDIFF_DESKTOP_BUILD:-1}"
SPARKLE_FEED_URL="${NEONDIFF_SPARKLE_FEED_URL:-}"
SPARKLE_PUBLIC_KEY="${NEONDIFF_SPARKLE_PUBLIC_ED_KEY:-}"
if [ "$BUILD_CONFIGURATION" = "release" ]; then
  if [ "${NEONDIFF_SPARKLE_REQUIRED+x}" = "x" ] \
    && [ "$NEONDIFF_SPARKLE_REQUIRED" != "1" ]; then
    echo "Release builds require NEONDIFF_SPARKLE_REQUIRED=1" >&2
    exit 2
  fi
  SPARKLE_REQUIRED=1
else
  SPARKLE_REQUIRED="${NEONDIFF_SPARKLE_REQUIRED:-0}"
fi
PAID_BETA_CONTRACT="${NEONDIFF_DESKTOP_PAID_BETA_CONTRACT:-}"
MANAGED_GITHUB_BROKER_ENABLED="${NEONDIFF_DESKTOP_MANAGED_GITHUB_BROKER_ENABLED:-}"
GITHUB_BROKER_ORIGIN="${NEONDIFF_DESKTOP_GITHUB_BROKER_ORIGIN:-}"
BYO_GITHUB_ENABLED="${NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED:-}"

if [ "$SPARKLE_REQUIRED" != "0" ] && [ "$SPARKLE_REQUIRED" != "1" ]; then
  echo "NEONDIFF_SPARKLE_REQUIRED must be 0 or 1" >&2
  exit 2
fi

trim_surrounding_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

SPARKLE_FEED_URL_TRIMMED="$(trim_surrounding_whitespace "$SPARKLE_FEED_URL")"
SPARKLE_PUBLIC_KEY_TRIMMED="$(trim_surrounding_whitespace "$SPARKLE_PUBLIC_KEY")"
if [ "$SPARKLE_FEED_URL" != "$SPARKLE_FEED_URL_TRIMMED" ] \
  || [ "$SPARKLE_PUBLIC_KEY" != "$SPARKLE_PUBLIC_KEY_TRIMMED" ]; then
  echo "Sparkle feed and public key must not contain surrounding whitespace" >&2
  exit 2
fi
if { [ -n "$SPARKLE_FEED_URL" ] && [ -z "$SPARKLE_PUBLIC_KEY" ]; } \
  || { [ -z "$SPARKLE_FEED_URL" ] && [ -n "$SPARKLE_PUBLIC_KEY" ]; }; then
  echo "Sparkle feed and public key must be configured together" >&2
  exit 2
fi
if [ -n "$SPARKLE_FEED_URL" ]; then
  case "$SPARKLE_FEED_URL" in
    https://*) ;;
    *)
      echo "NEONDIFF_SPARKLE_FEED_URL must use https" >&2
      exit 2
      ;;
  esac
fi
if [ "$SPARKLE_REQUIRED" = "1" ] && [ -z "$SPARKLE_FEED_URL" ]; then
  echo "A signed Sparkle feed is required for this release build" >&2
  exit 2
fi

resolve_production_contract_mode() {
  if [ -z "$PAID_BETA_CONTRACT" ] \
    && [ -z "$MANAGED_GITHUB_BROKER_ENABLED" ] \
    && [ -z "$GITHUB_BROKER_ORIGIN" ] \
    && [ -z "$BYO_GITHUB_ENABLED" ]; then
    echo "none"
    return
  fi

  if [ "$BUILD_CONFIGURATION" != "release" ]; then
    echo "production configuration is accepted only for release bundles" >&2
    return 2
  fi

  if [ "$PAID_BETA_CONTRACT" = "paid-mac-beta-v1" ] \
    && [ "$MANAGED_GITHUB_BROKER_ENABLED" = "true" ] \
    && [ "$GITHUB_BROKER_ORIGIN" = "https://neondiff-license.fly.dev" ] \
    && [ -z "$BYO_GITHUB_ENABLED" ]; then
    echo "managed"
    return
  fi

  if [ "$PAID_BETA_CONTRACT" = "paid-mac-beta-byo-v1" ] \
    && [ "$BYO_GITHUB_ENABLED" = "true" ] \
    && [ -z "$MANAGED_GITHUB_BROKER_ENABLED" ] \
    && [ -z "$GITHUB_BROKER_ORIGIN" ]; then
    echo "byo"
    return
  fi

  echo "production configuration must match exactly one paid beta contract" >&2
  return 2
}

PRODUCTION_CONTRACT_MODE="$(resolve_production_contract_mode)"
if [ "$MODE" = "production-contract-check" ]; then
  echo "$PRODUCTION_CONTRACT_MODE"
  exit 0
fi

if [ -x "$APP_BINARY" ]; then
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    proc_path="$(/bin/ps -p "$pid" -o comm= 2>/dev/null || true)"
    if [ "$proc_path" = "$APP_BINARY" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done < <(pgrep -x "$PRODUCT_NAME" 2>/dev/null || true)
fi

cd "$ROOT_DIR"
swift build -c "$BUILD_CONFIGURATION" --product "$PRODUCT_NAME"
if [ "$BUILD_CONFIGURATION" = "debug" ]; then
  swift build -c debug --product NeonDiffDesktopFixtureResolve
fi
BUILD_DIR="$(swift build -c "$BUILD_CONFIGURATION" --show-bin-path)"
BUILD_BINARY="$BUILD_DIR/$PRODUCT_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS" "$APP_RESOURCES"
cp "$BUILD_BINARY" "$APP_BINARY"
chmod +x "$APP_BINARY"
if [ "$BUILD_CONFIGURATION" = "release" ]; then
  "$SCRIPT_DIR/release-rpaths.sh" sanitize "$APP_BINARY"
  "$SCRIPT_DIR/release-rpaths.sh" assert "$APP_BINARY"
fi
if [ "$BUILD_CONFIGURATION" = "debug" ]; then
  mkdir -p "$APP_HELPERS"
  cp "$BUILD_DIR/NeonDiffDesktopFixtureResolve" "$APP_HELPERS/NeonDiffDesktopFixtureResolve"
  chmod +x "$APP_HELPERS/NeonDiffDesktopFixtureResolve"
fi

RESOURCE_DIR="$(find "$BUILD_DIR" "$ROOT_DIR/.build" \( -name "${PRODUCT_NAME}_${PRODUCT_NAME}.bundle" -o -name "${PRODUCT_NAME}_${PRODUCT_NAME}.resources" \) -type d -print -quit 2>/dev/null || true)"
if [ -n "$RESOURCE_DIR" ]; then
  ditto "$RESOURCE_DIR" "$APP_RESOURCES/$(basename "$RESOURCE_DIR")"
fi

if [ -f "$ROOT_DIR/THIRD_PARTY_NOTICES.md" ]; then
  cp "$ROOT_DIR/THIRD_PARTY_NOTICES.md" "$APP_RESOURCES/THIRD_PARTY_NOTICES.md"
fi

cp "$ROOT_DIR/Sources/NeonDiffDesktop/Resources/NeonDiff.icns" "$APP_RESOURCES/NeonDiff.icns"
cp "$ROOT_DIR/Sources/NeonDiffDesktop/Resources/NeonDiff-Light.icns" "$APP_RESOURCES/NeonDiff-Light.icns"
cp "$ROOT_DIR/Sources/NeonDiffDesktop/Resources/NeonDiff-Dark.icns" "$APP_RESOURCES/NeonDiff-Dark.icns"

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
  <string>$PRODUCT_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleIconFile</key>
  <string>NeonDiff.icns</string>
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

case "$PRODUCTION_CONTRACT_MODE" in
  managed)
    /usr/libexec/PlistBuddy -c "Add :NeonDiffPaidBetaContract string $PAID_BETA_CONTRACT" "$INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Add :NeonDiffManagedGitHubBrokerEnabled bool true" "$INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Add :NeonDiffGitHubBrokerOrigin string $GITHUB_BROKER_ORIGIN" "$INFO_PLIST"
    ;;
  byo)
    /usr/libexec/PlistBuddy -c "Add :NeonDiffPaidBetaContract string $PAID_BETA_CONTRACT" "$INFO_PLIST"
    /usr/libexec/PlistBuddy -c "Add :NeonDiffBYOGitHubEnabled bool true" "$INFO_PLIST"
    ;;
esac

if [ -n "$SPARKLE_FEED_URL" ] && [ -n "$SPARKLE_PUBLIC_KEY" ]; then
  /usr/libexec/PlistBuddy -c "Add :SUFeedURL string $SPARKLE_FEED_URL" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string $SPARKLE_PUBLIC_KEY" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool true" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUScheduledCheckInterval real 21600" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :SUAutomaticallyUpdate bool false" "$INFO_PLIST"
fi

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  build|release-build)
    ;;
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$PRODUCT_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    sleep 1
    pgrep -x "$PRODUCT_NAME" >/dev/null
    ;;
  --bundle-check|bundle-check|release-bundle-check)
    /usr/bin/plutil -lint "$INFO_PLIST" >/dev/null
    test -f "$APP_RESOURCES/NeonDiff.icns"
    test -f "$APP_RESOURCES/NeonDiff-Light.icns"
    test -f "$APP_RESOURCES/NeonDiff-Dark.icns"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIconFile' "$INFO_PLIST")" = "NeonDiff.icns"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")" = "$PRODUCT_NAME"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$INFO_PLIST")" = "$APP_NAME"
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$INFO_PLIST")" = "$APP_NAME"
    if [ "$BUILD_CONFIGURATION" = "release" ]; then
      "$SCRIPT_DIR/release-rpaths.sh" assert "$APP_BINARY"
    fi
    INVALID_BUNDLE_ROOT_ENTRIES="$(find "$APP_BUNDLE" -mindepth 1 -maxdepth 1 ! -name Contents -print)"
    if [ -n "$INVALID_BUNDLE_ROOT_ENTRIES" ]; then
      echo "app bundle root may contain only Contents:" >&2
      echo "$INVALID_BUNDLE_ROOT_ENTRIES" >&2
      exit 1
    fi
    otool -L "$APP_BINARY"
    if otool -L "$APP_BINARY" | grep -q "Sparkle.framework"; then
      test -d "$APP_FRAMEWORKS/Sparkle.framework"
      otool -l "$APP_BINARY" | grep -q "@executable_path/../Frameworks"
    fi
    if [ "$SPARKLE_REQUIRED" = "1" ]; then
      test "$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$INFO_PLIST")" = "$SPARKLE_FEED_URL"
      test "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$INFO_PLIST")" = "$SPARKLE_PUBLIC_KEY"
      test "$(/usr/libexec/PlistBuddy -c 'Print :SUEnableAutomaticChecks' "$INFO_PLIST")" = "true"
      test "$(/usr/libexec/PlistBuddy -c 'Print :SUScheduledCheckInterval' "$INFO_PLIST")" = "21600.000000"
      test "$(/usr/libexec/PlistBuddy -c 'Print :SUAutomaticallyUpdate' "$INFO_PLIST")" = "false"
    fi
    ;;
  *)
    echo "usage: $0 [build|release-build|run|--debug|--logs|--telemetry|--verify|--bundle-check|release-bundle-check|preflight]" >&2
    exit 2
    ;;
esac
