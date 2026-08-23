# Immutable Mac update, rollback, and re-update

This customer/operator procedure starts with an immutable GitHub Release asset
and accepted packet. A source checkout, mutable `latest` URL, or running process
is not release identity; this document does not claim a shipped GA artifact.
Native signed Desktop and the separate checksum-managed B0 worker are separate
paths with separate state boundaries.

## 1. Confine staging and verify the accepted packet

Use a pre-created absolute directory under the current user's Application
Support tree, outside any checkout; never silently replace it with a guessed path:

```bash
set -euo pipefail
: "${HOME:?HOME is required}"
: "${RELEASE_ROOT:?set an existing absolute release-evidence root}"
: "${RELEASE_TAG:?set the immutable GitHub Release tag}"
: "${ARTIFACT_NAME:?set the packet-named ZIP asset}"
: "${ARTIFACT_SHA256:?set the packet ZIP SHA-256}"
: "${MANIFEST_URL:?set the packet manifest URL}"
: "${MANIFEST_SHA256:?set the packet manifest SHA-256}"
: "${APPCAST_URL:?set the packet appcast URL}"
: "${APPCAST_SHA256:?set the packet appcast SHA-256}"
: "${EXPECTED_VERSION:?set CFBundleShortVersionString from the packet}"
: "${EXPECTED_BUILD:?set CFBundleVersion from the packet}"
: "${EXPECTED_FEED_URL:?set SUFeedURL from the packet}"
: "${EXPECTED_KEY_FINGERPRINT:?set the SUPublicEDKey fingerprint from the packet}"
case "$RELEASE_ROOT" in /*) ;; *) echo "release root must be absolute" >&2; exit 1;; esac
test -d "$RELEASE_ROOT" || { echo "release root must already exist" >&2; exit 1; }
RELEASE_ROOT="$(cd "$RELEASE_ROOT" && pwd -P)"
if git -C "$RELEASE_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "release root must be outside every checkout" >&2; exit 1
fi
test -z "$(find "$RELEASE_ROOT" -mindepth 1 -maxdepth 1 -print -quit)" || { echo "release root must start empty" >&2; exit 1; }
ARTIFACT="$RELEASE_ROOT/$ARTIFACT_NAME"
MANIFEST="$RELEASE_ROOT/release-manifest.json"
APPCAST="$RELEASE_ROOT/appcast.xml"
gh release download "$RELEASE_TAG" --repo electricsheephq/evaos-code-review-bot-neondiff \
  --pattern "$ARTIFACT_NAME" --dir "$RELEASE_ROOT"
curl --fail --location --silent --show-error "$MANIFEST_URL" --output "$MANIFEST"
curl --fail --location --silent --show-error "$APPCAST_URL" --output "$APPCAST"
test "$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')" = "$ARTIFACT_SHA256"
test "$(shasum -a 256 "$MANIFEST" | awk '{print $1}')" = "$MANIFEST_SHA256"
test "$(shasum -a 256 "$APPCAST" | awk '{print $1}')" = "$APPCAST_SHA256"
jq -e --arg tag "$RELEASE_TAG" --arg name "$ARTIFACT_NAME" \
  --arg sha "$ARTIFACT_SHA256" --arg version "$EXPECTED_VERSION" \
  --arg build "$EXPECTED_BUILD" --arg feed "$EXPECTED_FEED_URL" \
  --arg key "$EXPECTED_KEY_FINGERPRINT" --arg appcast "$APPCAST_SHA256" \
  '.release.tag == $tag and .artifact.name == $name and .artifact.sha256 == $sha
   and .bundle.version == $version and .bundle.build == $build
   and .feed.url == $feed and .feed.publicKeyFingerprint == $key
   and .feed.appcastSha256 == $appcast' "$MANIFEST"
grep -Fq "<link>$EXPECTED_FEED_URL</link>" "$APPCAST"
grep -Fq "sparkle:shortVersionString=\"$EXPECTED_VERSION\"" "$APPCAST"
grep -Fq "sparkle:version=\"$EXPECTED_BUILD\"" "$APPCAST"
grep -Eq 'sparkle:edSignature="[^"]+"' "$APPCAST"
```

Extract into a new, empty directory and verify the exact bundle before install
or update. `NOTARY_PROFILE` is an owner-held profile name, never a key value:

```bash
: "${NOTARY_PROFILE:?set the owner-held notarytool profile name}"
: "${NOTARY_ID:?set the accepted packet's notary submission id}"
STAGE="$RELEASE_ROOT/stage-$EXPECTED_BUILD"
test ! -e "$STAGE" && mkdir "$STAGE"
ditto -x -k "$ARTIFACT" "$STAGE"
APP="$STAGE/NeonDiff.app"
test -d "$APP"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$EXPECTED_VERSION"
test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")" = "$EXPECTED_BUILD"
test "$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$APP/Contents/Info.plist")" = "$EXPECTED_FEED_URL"
test "$(printf '%s' "$(/usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' "$APP/Contents/Info.plist")" | shasum -a 256 | awk '{print $1}')" = "$EXPECTED_KEY_FINGERPRINT"
codesign --verify --deep --strict --verbose=2 "$APP"
xcrun notarytool info "$NOTARY_ID" --keychain-profile "$NOTARY_PROFILE" --output-format json | jq -e '.status == "Accepted"'
xcrun stapler validate "$APP"
spctl -a -vv --type execute "$APP"
```

## 2. Install and forward-update the signed Desktop

For a first install, atomically move the verified app into `/Applications` and
keep any prior app as a non-overwritten recovery copy. For a forward update,
use **Check for Updates**; Sparkle must select the packet's exact feed, build,
enclosure digest, and EdDSA signature. Repeat plist, codesign, notary, stapler,
and Gatekeeper checks against the installed app; a running app is not enough.

```bash
APP_INSTALL="/Applications/NeonDiff.app"
APP_SWAP="$RELEASE_ROOT/NeonDiff.app.new"
APP_PREVIOUS="$RELEASE_ROOT/NeonDiff.app.previous"
test ! -e "$APP_SWAP" && test ! -e "$APP_PREVIOUS"
ditto "$APP" "$APP_SWAP"
if test -e "$APP_INSTALL"; then mv "$APP_INSTALL" "$APP_PREVIOUS"; fi
mv "$APP_SWAP" "$APP_INSTALL"
open "$APP_INSTALL"
```

## 3. Roll back and re-update

The current Sparkle appcast cannot downgrade an installed build. Do not try to
make `rollback_to`, a lower `sparkle:version`, or **Check for Updates** perform
a downgrade. Retain the prior accepted ZIP, manifest, and appcast as a complete
packet. Run the same digest, manifest, feed, plist, codesign, notary, stapler,
and Gatekeeper checks above against that prior packet, then install that verified
prior app using a new swap/backup path. Restore the prior signed feed/channel
only after byte proof through its approved host; the current appcast guide has
no generic upload command.

After the prior app starts, verify the same account, bot, config, `state/reviews.sqlite`,
allowlist, Keychain identity, selected LaunchAgent label, and exactly one worker
pair (wrapper/helper). Restore the newer packet's feed/channel only after
its ZIP, manifest, appcast, and signatures pass the same checks; use **Check for
Updates** once to re-update, then repeat the installed-app and state checks.

## 4. Existing local B0 worker (separate from the signed app)
The B0 bundle is checksum-managed and is not a source reset, npm dist-tag, or
Sparkle update. Extract the complete bundle outside the checkout, compare its
outer ZIP, manifest, and inner tarball digests with the release packet, and use
the exact selected LaunchAgent label. The first migration has no rollback target.

```bash
set -euo pipefail
BUNDLE_DIR="$(pwd -P)"
test -f "$BUNDLE_DIR/install-b0-worker-candidate.mjs"
: "${WORKER_LABEL:?set the exact existing LaunchAgent label}"
: "${MANIFEST_SHA256:?set the packet manifest SHA-256}"
node --version
node install-b0-worker-candidate.mjs update \
  --manifest "$BUNDLE_DIR/neondiff-1.1.0-beta.N-b0-candidate-manifest.json" \
  --manifest-sha256 "$MANIFEST_SHA256" \
  --tarball "$BUNDLE_DIR/neondiff-1.1.0-beta.N.tgz" \
  --launchd-label "$WORKER_LABEL" --dry-run true
node install-b0-worker-candidate.mjs update \
  --manifest "$BUNDLE_DIR/neondiff-1.1.0-beta.N-b0-candidate-manifest.json" \
  --manifest-sha256 "$MANIFEST_SHA256" \
  --tarball "$BUNDLE_DIR/neondiff-1.1.0-beta.N.tgz" \
  --launchd-label "$WORKER_LABEL" --dry-run false --confirm true
```

After a later candidate is installed, retain its predecessor's complete bundle.
Run `node install-b0-worker-candidate.mjs rollback --manifest "$PRIOR_MANIFEST" --manifest-sha256 "$PRIOR_MANIFEST_SHA256" --tarball "$PRIOR_TARBALL" --launchd-label "$WORKER_LABEL" --dry-run true` with that predecessor, then repeat with `--dry-run false --confirm true`.
Re-run the same `update` command for re-update. The installer preserves the existing absolute
plist `--config`, label/environment, provider state, repository allowlist,
Keychain entries, DB, and exactly one worker pair; it never reads private-key
bytes or creates a second worker. Stop if any identity, path, or state check is ambiguous.

This procedure is documentation/source proof only. It does not prove that a
signed artifact, hosted feed, Apple ticket, installed update, rollback,
re-update, runtime, fleet, or customer-ready GA release exists.
