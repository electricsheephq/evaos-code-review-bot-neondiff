#!/usr/bin/env bash
set -euo pipefail

APP_NAME="NeonDiffDesktop"
ARTIFACT_NAME="NeonDiffDesktop.app.zip"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
RELEASE_SMOKE_DIR="$DIST_DIR/release-smoke"
ARTIFACT_PATH="$RELEASE_SMOKE_DIR/$ARTIFACT_NAME"
METADATA_PATH="$RELEASE_SMOKE_DIR/desktop-release-smoke-metadata.json"

SOURCE_SHA_PROVIDED=0
SOURCE_REF_PROVIDED=0
if [ -n "${SOURCE_SHA+x}" ]; then
  SOURCE_SHA_PROVIDED=1
fi
if [ -n "${SOURCE_REF+x}" ]; then
  SOURCE_REF_PROVIDED=1
fi
ARTIFACT_CLASSIFICATION="${NEONDIFF_DESKTOP_ARTIFACT_CLASSIFICATION:-unsigned-desktop-release-smoke}"
UI_LAUNCH="${NEONDIFF_DESKTOP_UI_LAUNCH:-false}"
VISUAL_SMOKE_REQUIRED="${NEONDIFF_DESKTOP_VISUAL_SMOKE_REQUIRED:-true}"
PROOF_BOUNDARY="${NEONDIFF_DESKTOP_PROOF_BOUNDARY:-non-release app bundle build, hosted-runner-safe core checks, appcast checks, bundle structure check, artifact checksum, and metadata only}"

normalize_bool() {
  local value="$1"
  local name="$2"
  case "$value" in
    true|false)
      printf '%s\n' "$value"
      ;;
    *)
      echo "$name must be true or false" >&2
      exit 2
      ;;
  esac
}

ensure_clean_source_tree() {
  if ! git -C "$REPO_ROOT" diff --quiet --ignore-submodules --; then
    echo "source tree has unstaged changes; set SOURCE_SHA and SOURCE_REF explicitly or commit/stash before release proof" >&2
    exit 2
  fi
  if ! git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules --; then
    echo "source tree has staged changes; set SOURCE_SHA and SOURCE_REF explicitly or commit/stash before release proof" >&2
    exit 2
  fi
  if [ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]; then
    echo "source tree has untracked files; set SOURCE_SHA and SOURCE_REF explicitly or clean before release proof" >&2
    exit 2
  fi
}

verify_existing_app_launch() {
  local app_binary="$APP_BUNDLE/Contents/MacOS/$APP_NAME"
  /usr/bin/open -n "$APP_BUNDLE"
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      proc_path="$(/bin/ps -p "$pid" -o comm= 2>/dev/null || true)"
      if [ "$proc_path" = "$app_binary" ]; then
        return 0
      fi
    done < <(pgrep -x "$APP_NAME" 2>/dev/null || true)
    sleep 0.2
  done
  echo "app launch proof failed: $APP_NAME did not start from $APP_BUNDLE" >&2
  exit 1
}

if [ "$SOURCE_SHA_PROVIDED" -ne "$SOURCE_REF_PROVIDED" ]; then
  echo "SOURCE_SHA and SOURCE_REF must be provided together" >&2
  exit 2
fi

if [ "$SOURCE_SHA_PROVIDED" -eq 1 ]; then
  if [ -z "$SOURCE_SHA" ] || [ -z "$SOURCE_REF" ]; then
    echo "SOURCE_SHA and SOURCE_REF must be non-empty when provided" >&2
    exit 2
  fi
  SOURCE_SHA="$SOURCE_SHA"
  SOURCE_REF="$SOURCE_REF"
else
  ensure_clean_source_tree
  SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  SOURCE_REF="$(git -C "$REPO_ROOT" symbolic-ref -q --short HEAD || git -C "$REPO_ROOT" rev-parse --short HEAD)"
fi

if [ ! -d "$APP_BUNDLE" ]; then
  echo "missing app bundle: $APP_BUNDLE" >&2
  exit 1
fi

if [ ! -f "$INFO_PLIST" ]; then
  echo "missing Info.plist: $INFO_PLIST" >&2
  exit 1
fi

if [ "$UI_LAUNCH" = "true" ]; then
  verify_existing_app_launch
fi

UI_LAUNCH_JSON="$(normalize_bool "$UI_LAUNCH" "NEONDIFF_DESKTOP_UI_LAUNCH")"
VISUAL_SMOKE_REQUIRED_JSON="$(normalize_bool "$VISUAL_SMOKE_REQUIRED" "NEONDIFF_DESKTOP_VISUAL_SMOKE_REQUIRED")"

mkdir -p "$RELEASE_SMOKE_DIR"
ditto -c -k --keepParent "$APP_BUNDLE" "$ARTIFACT_PATH"

ARTIFACT_SHA256="$(shasum -a 256 "$ARTIFACT_PATH" | awk '{print $1}')"
BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$INFO_PLIST")"
SHORT_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$INFO_PLIST")"
BUILD_VERSION="$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$INFO_PLIST")"

SIGNING_DETAILS="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1 || true)"
SIGNING_IDENTITY_CLASS="unsigned"
if printf '%s\n' "$SIGNING_DETAILS" | grep -q "Authority=Developer ID Application"; then
  SIGNING_IDENTITY_CLASS="developer-id"
elif printf '%s\n' "$SIGNING_DETAILS" | grep -q "Authority="; then
  SIGNING_IDENTITY_CLASS="signed-non-developer-id"
fi

jq -n \
  --arg workflow "desktop-release-smoke" \
  --arg artifact "$ARTIFACT_NAME" \
  --arg artifact_sha256 "$ARTIFACT_SHA256" \
  --arg artifact_classification "$ARTIFACT_CLASSIFICATION" \
  --arg source_sha "$SOURCE_SHA" \
  --arg source_ref "$SOURCE_REF" \
  --arg app_bundle_path "apps/neondiff-desktop/dist/$APP_NAME.app" \
  --arg bundle_id "$BUNDLE_ID" \
  --arg short_version "$SHORT_VERSION" \
  --arg build_version "$BUILD_VERSION" \
  --arg signing_identity_class "$SIGNING_IDENTITY_CLASS" \
  --argjson ui_launch "$UI_LAUNCH_JSON" \
  --argjson visual_smoke_required "$VISUAL_SMOKE_REQUIRED_JSON" \
  --argjson release_ready false \
  --argjson customer_ready false \
  --arg proof_boundary "$PROOF_BOUNDARY" \
  '{
    workflow: $workflow,
    artifact: $artifact,
    artifact_sha256: $artifact_sha256,
    artifact_classification: $artifact_classification,
    source_sha: $source_sha,
    source_ref: $source_ref,
    app_bundle_path: $app_bundle_path,
    bundle_id: $bundle_id,
    short_version: $short_version,
    build_version: $build_version,
    signing_identity_class: $signing_identity_class,
    ui_launch: $ui_launch,
    visual_smoke_required: $visual_smoke_required,
    release_ready: $release_ready,
    customer_ready: $customer_ready,
    proof_boundary: $proof_boundary
  }' >"$METADATA_PATH"

cat "$METADATA_PATH"
