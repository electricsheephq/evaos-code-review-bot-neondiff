#!/usr/bin/env bash
set -euo pipefail

APP_NAME="NeonDiff"
EXECUTABLE_NAME="NeonDiffDesktop"
BUNDLE_NAME="NeonDiff"
ARTIFACT_NAME="NeonDiff.app.zip"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
SOURCE_APP_BUNDLE="$DIST_DIR/$BUNDLE_NAME.app"
RELEASE_SMOKE_DIR="$DIST_DIR/release-smoke"
APP_BUNDLE="$RELEASE_SMOKE_DIR/$APP_NAME.app"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
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

assert_byo_production_contract() {
  local info_plist="$1"
  local contract
  local byo_enabled
  local managed_enabled
  local managed_origin
  contract="$(/usr/libexec/PlistBuddy -c "Print :NeonDiffPaidBetaContract" "$info_plist" 2>/dev/null || true)"
  byo_enabled="$(/usr/libexec/PlistBuddy -c "Print :NeonDiffBYOGitHubEnabled" "$info_plist" 2>/dev/null || true)"
  managed_enabled="$(/usr/libexec/PlistBuddy -c "Print :NeonDiffManagedGitHubBrokerEnabled" "$info_plist" 2>/dev/null || true)"
  managed_origin="$(/usr/libexec/PlistBuddy -c "Print :NeonDiffGitHubBrokerOrigin" "$info_plist" 2>/dev/null || true)"
  if [ "$contract" != "paid-mac-beta-byo-v1" ] \
    || [ "$byo_enabled" != "true" ] \
    || [ -n "$managed_enabled" ] \
    || [ -n "$managed_origin" ]; then
    echo "release artifact is missing the exact BYO production contract" >&2
    exit 1
  fi
}

ensure_clean_source_tree() {
  if ! git -C "$REPO_ROOT" diff --quiet --ignore-submodules --; then
    echo "source tree has unstaged changes; commit or stash before release proof" >&2
    exit 2
  fi
  if ! git -C "$REPO_ROOT" diff --cached --quiet --ignore-submodules --; then
    echo "source tree has staged changes; commit or stash before release proof" >&2
    exit 2
  fi
  if [ -n "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]; then
    echo "source tree has untracked files; clean before release proof" >&2
    exit 2
  fi
}

derive_source_ref() {
  local symbolic tags
  symbolic="$(git -C "$REPO_ROOT" symbolic-ref -q HEAD || true)"
  if [ -n "$symbolic" ]; then
    printf '%s\n' "$symbolic"
    return
  fi
  tags="$(git -C "$REPO_ROOT" tag --points-at "$DERIVED_SOURCE_SHA")"
  case "$tags" in
    "") printf '%s\n' "$DERIVED_SOURCE_SHA" ;;
    *$'\n'*) echo "source ref is ambiguous" >&2; return 2 ;;
    *) printf 'refs/tags/%s\n' "$tags" ;;
  esac
}

verify_existing_app_launch() {
  local app_binary="$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
  /usr/bin/open -n "$APP_BUNDLE"
  local deadline=$((SECONDS + 10))
  while [ "$SECONDS" -lt "$deadline" ]; do
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      proc_path="$(/bin/ps -p "$pid" -o comm= 2>/dev/null || true)"
      if [ "$proc_path" = "$app_binary" ]; then
        return 0
      fi
    done < <(pgrep -x "$EXECUTABLE_NAME" 2>/dev/null || true)
    sleep 0.2
  done
  echo "app launch proof failed: $EXECUTABLE_NAME did not start from $APP_BUNDLE" >&2
  exit 1
}

if [ "$SOURCE_SHA_PROVIDED" -ne "$SOURCE_REF_PROVIDED" ]; then
  echo "SOURCE_SHA and SOURCE_REF must be provided together" >&2
  exit 2
fi

ensure_clean_source_tree
DERIVED_SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [[ ! "$DERIVED_SOURCE_SHA" =~ ^[a-f0-9]{40}$ ]] \
  || ! git -C "$REPO_ROOT" cat-file -e "$DERIVED_SOURCE_SHA^{commit}"; then
  echo "release source identity is not canonical" >&2
  exit 2
fi
DERIVED_SOURCE_REF="$(derive_source_ref)"
if [ "$SOURCE_SHA_PROVIDED" -eq 1 ]; then
  if [ -z "$SOURCE_SHA" ] || [ -z "$SOURCE_REF" ]; then
    echo "SOURCE_SHA and SOURCE_REF must be non-empty when provided" >&2
    exit 2
  fi
  if [ "$SOURCE_SHA" != "$DERIVED_SOURCE_SHA" ] \
    || [ "$SOURCE_REF" != "$DERIVED_SOURCE_REF" ]; then
    echo "provided source identity does not match the exact checkout" >&2
    exit 2
  fi
fi
SOURCE_SHA="$DERIVED_SOURCE_SHA"
SOURCE_REF="$DERIVED_SOURCE_REF"

if [ ! -d "$SOURCE_APP_BUNDLE" ]; then
  echo "missing app bundle: $SOURCE_APP_BUNDLE" >&2
  exit 1
fi

if [ ! -f "$SOURCE_APP_BUNDLE/Contents/Info.plist" ]; then
  echo "missing Info.plist: $SOURCE_APP_BUNDLE/Contents/Info.plist" >&2
  exit 1
fi

mkdir -p "$RELEASE_SMOKE_DIR"
rm -rf "$APP_BUNDLE"
rm -f "$ARTIFACT_PATH" "$METADATA_PATH"
ditto "$SOURCE_APP_BUNDLE" "$APP_BUNDLE"
assert_byo_production_contract "$INFO_PLIST"
ARTIFACT_SOURCE_SHA="$(/usr/libexec/PlistBuddy -c "Print :NeonDiffSourceSHA" "$INFO_PLIST" 2>/dev/null || true)"
if [ "$ARTIFACT_SOURCE_SHA" != "$SOURCE_SHA" ]; then
  echo "artifact source identity does not match the exact checkout" >&2
  exit 1
fi

if [ "$UI_LAUNCH" = "true" ]; then
  verify_existing_app_launch
fi

UI_LAUNCH_JSON="$(normalize_bool "$UI_LAUNCH" "NEONDIFF_DESKTOP_UI_LAUNCH")"
VISUAL_SMOKE_REQUIRED_JSON="$(normalize_bool "$VISUAL_SMOKE_REQUIRED" "NEONDIFF_DESKTOP_VISUAL_SMOKE_REQUIRED")"

ditto -c -k --keepParent "$APP_BUNDLE" "$ARTIFACT_PATH"

ensure_clean_source_tree
if [ "$(git -C "$REPO_ROOT" rev-parse HEAD)" != "$SOURCE_SHA" ]; then
  echo "source identity changed during release proof" >&2
  exit 2
fi

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
  --arg artifact_source_sha "$ARTIFACT_SOURCE_SHA" \
  --arg source_ref "$SOURCE_REF" \
  --arg app_bundle_path "apps/neondiff-desktop/dist/release-smoke/$APP_NAME.app" \
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
    artifact_source_sha: $artifact_source_sha,
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
