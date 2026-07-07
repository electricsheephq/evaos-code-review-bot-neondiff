# NeonDiff Desktop Mac Release Runbook

This is the handoff-grade runbook for building, signing, notarizing, stapling,
validating, and recording evidence for a NeonDiff Desktop macOS artifact. It is
a release-execution checklist for the owner and a Codex agent once the missing
Apple/Sparkle inputs are available.

Proof boundary: this document does not prove a signed artifact exists, does not
submit anything to Apple, does not publish an appcast, and does not make the
desktop update channel GA-ready. Issue #322 closes the documentation lane only.
Parent issue #116 owns the signed auto-update channel, #323 owns appcast
fixtures/dry-run generation, #324 owns credential naming/custody, #325 owns the
desktop onboarding wizard, #327 owns production license-service deployment, and
#374 is the roadmap handoff index.

## Preconditions

Run every command from a fresh checkout of
`electricsheephq/evaos-code-review-bot-neondiff` on the intended release source
SHA. Record the source SHA before any build:

```sh
git fetch origin main --tags
git checkout main
git pull --ff-only origin main
git status --short
git rev-parse HEAD
```

Stop if the checkout is dirty, behind the intended release SHA, or carrying
unrelated local changes.

Before building, run the read-only credential doctor:

```sh
apps/neondiff-desktop/script/preflight-credentials.sh
apps/neondiff-desktop/script/preflight-credentials.sh --json \
  > /Volumes/LEXAR/Codex/evidence/neondiff-desktop/<date>/<version>/credential-preflight.json
```

The doctor reports presence only. It does not sign, notarize, upload, fetch
artifacts, or print secret values. Canonical credential names and custody rules
live in `apps/neondiff-desktop/docs/signing-credentials.md`.

Known #322 handoff gap: this machine was reported to have a Developer ID
Application certificate and Sparkle private key available, but to be missing
notarization credentials and the Sparkle public key. Treat that state as a
release blocker until the owner provides the notarization input and
`NEONDIFF_SPARKLE_PUBLIC_ED_KEY`.

Required owner/Codex inputs for a real signing run:

- Exact release source SHA, version, build number, and channel.
- Developer ID Application identity name, for example
  `Developer ID Application: <Team Name> (<TEAMID>)`.
- Notarization path: either `NEONDIFF_NOTARY_KEYCHAIN_PROFILE` or the App Store
  Connect API-key environment described in #324.
- Sparkle public key as `NEONDIFF_SPARKLE_PUBLIC_ED_KEY`.
- Sparkle feed URL as `NEONDIFF_SPARKLE_FEED_URL`.
- Appcast hosting destination and rollback destination.
- Evidence packet directory under `/Volumes/LEXAR/Codex/evidence/`.

## Build The Release App

Set the exact bundle version and build number before creating the app bundle.
The bundle id is `com.electricsheephq.NeonDiffDesktop`; the minimum supported
macOS version is 14.0.

```sh
cd apps/neondiff-desktop
export NEONDIFF_DESKTOP_VERSION="<version>"
export NEONDIFF_DESKTOP_BUILD="<build>"
export NEONDIFF_SPARKLE_PUBLIC_ED_KEY="<owner-provided-public-key>"
export NEONDIFF_SPARKLE_FEED_URL="<owner-approved-feed-url>"

script/build_and_run.sh build
script/build_and_run.sh bundle-check
```

Expected output artifact:

```text
apps/neondiff-desktop/dist/NeonDiffDesktop.app
```

Record the bundle metadata and checksum:

```sh
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" dist/NeonDiffDesktop.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" dist/NeonDiffDesktop.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" dist/NeonDiffDesktop.app/Contents/Info.plist
shasum -a 256 dist/NeonDiffDesktop.app/Contents/MacOS/NeonDiffDesktop
```

Do not ship a dev/ad-hoc artifact from this step. The build is only a candidate
until the signing, notarization, stapling, Gatekeeper, and appcast evidence below
all pass.

## Codesign

Sign the embedded framework first when `Sparkle.framework` exists, then sign the
outer app with hardened runtime and timestamp enabled.

```sh
cd apps/neondiff-desktop
IDENTITY="Developer ID Application: <Team Name> (<TEAMID>)"
APP="dist/NeonDiffDesktop.app"
SPARKLE_FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"

if [ -d "$SPARKLE_FRAMEWORK" ]; then
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$SPARKLE_FRAMEWORK"
fi

codesign --force --deep --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vv --type execute "$APP"
```

Evidence to capture:

- Developer ID identity name, not private key material.
- `codesign --verify --deep --strict --verbose=2` output.
- `spctl -a -vv --type execute` output.
- `codesign -dv --verbose=4 "$APP"` output with any certificate fingerprints
  redacted if they are not intended for the public evidence packet.

Stop on any nested-code, hardened-runtime, timestamp, entitlement, or Gatekeeper
failure. Do not continue to notarization with a failed signing check.

## Notarize And Staple

Create a zip for Apple notarization with `ditto`, then submit it through one of
the notarization paths documented in #324.

```sh
cd apps/neondiff-desktop
APP="dist/NeonDiffDesktop.app"
ZIP="/Volumes/LEXAR/Codex/evidence/neondiff-desktop/<date>/<version>/NeonDiffDesktop.zip"

ditto -c -k --keepParent "$APP" "$ZIP"
shasum -a 256 "$ZIP"
```

Keychain-profile path:

```sh
xcrun notarytool submit "$ZIP" \
  --keychain-profile "${NEONDIFF_NOTARY_KEYCHAIN_PROFILE:-neondiff-notary}" \
  --wait
```

App Store Connect API-key path:

```sh
xcrun notarytool submit "$ZIP" \
  --key "$NEONDIFF_NOTARY_API_KEY_PATH" \
  --key-id "$NEONDIFF_NOTARY_API_KEY_ID" \
  --issuer "$NEONDIFF_NOTARY_API_ISSUER_ID" \
  --wait
```

After Apple accepts the submission, staple and re-verify:

```sh
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -vv --type execute "$APP"
```

Evidence to capture:

- Notary submission UUID and final status.
- Redacted `notarytool submit --wait` output.
- `stapler staple` and `stapler validate` output.
- Post-staple `codesign` and `spctl` output.

Stop if notarization is rejected, if stapling fails, or if post-staple
Gatekeeper verification fails. The release artifact is not ready until all three
states are accepted.

## Appcast, Signature, Hosting, And Rollback

Use the #323 appcast generator and committed fixtures as the local appcast
model. The generator creates local XML only; it does not sign, upload, or
fabricate a real Sparkle signature.

```sh
apps/neondiff-desktop/script/generate-appcast.sh \
  --fixture apps/neondiff-desktop/fixtures/appcast/beta.json \
  --output /Volumes/LEXAR/Codex/evidence/neondiff-desktop/<date>/<version>/neondiff-beta-appcast.xml \
  --dry-run
```

For a real release appcast, update the manifest metadata with the hosted artifact
URL, version/build, release notes URL, channel, minimum system version, checksum,
and Sparkle EdDSA signature. The EdDSA signature must come from Sparkle's
`sign_update` using owner-custodied private key material. Never commit, log, or
write the Sparkle private key to evidence.

Owner decision still required: choose and document the appcast hosting URL and
artifact hosting URL before publishing any feed. The feed URL must match the
`NEONDIFF_SPARKLE_FEED_URL` baked into the signed app.

Rollback proof:

- Generate or reference the #323 rollback fixture/appcast.
- Record the rollback target version, build, channel, artifact URL, checksum,
  release-note URL, and reason.
- Confirm the rollback appcast excludes the superseded newer build.

Signature-failure proof:

- Reference the #323 signature-failure fixture and evidence.
- Confirm the expected client-side status is `signature_error`.
- Do not treat the dry-run fixture as real Sparkle client proof; real client
  signature failure requires a signed/notarized app and hosted appcast.

License boundary:

- Private/gated update behavior depends on #327 production license-service
  deployment.
- Until #327 is live and enabled for the channel, release notes must say whether
  updates are public, gated, or intentionally deferred.

## Evidence Packet

Create a public-safe packet under:

```text
/Volumes/LEXAR/Codex/evidence/neondiff-desktop/<date>/<version>/
```

Minimum files:

- `source.txt`: repo, branch, source SHA, tag or intended tag, version, build,
  bundle id, channel, operator, and UTC timestamp.
- `credential-preflight.json`: output from `preflight-credentials.sh --json`.
- `build.txt`: build commands, bundle metadata, and checksums.
- `codesign.txt`: signing command shapes and verification output.
- `notary.txt`: notary submission UUID/status and redacted output.
- `stapler.txt`: stapler output and post-staple verification.
- `spctl.txt`: Gatekeeper assessment output.
- `appcast.xml`: generated appcast for the release channel.
- `rollback-appcast.xml`: rollback feed or a link to the rollback fixture
  evidence.
- `signature-failure.txt`: signature-failure fixture/reference and expected
  status.
- `checksums.txt`: artifact and appcast checksums.
- `release-notes.md`: operator-facing release notes and rollback command.
- `handoff.md`: owner-provided inputs, unresolved owner decisions, and any
  stopped gate.

Never include:

- Developer ID private keys, `.p12` files, certificate passwords, or keychain
  exports.
- App Store Connect private key files or raw key contents.
- Sparkle private key material.
- License keys, customer identifiers, tokens, cookies, or private repository
  data unrelated to the release.

## Failure Taxonomy

Use these names in evidence and owner handoffs so future agents can resume
without re-triaging the same failure:

- `credential_missing`: credential doctor reports a required missing or invalid
  signing/notarization/Sparkle input.
- `dirty_checkout`: source checkout is dirty, stale, or not at the intended SHA.
- `unsigned_or_ad_hoc`: bundle was not signed with Developer ID Application.
- `wrong_identity`: codesign identity does not match the intended team.
- `nested_code_signing_failed`: embedded framework or helper verification fails.
- `hardened_runtime_failed`: signing omitted hardened runtime or timestamp.
- `notarization_rejected`: Apple notary submission did not reach accepted state.
- `staple_failed`: accepted notarization could not be stapled or validated.
- `gatekeeper_rejected`: `spctl` does not accept the final stapled app.
- `appcast_signature_missing`: release feed lacks a real EdDSA signature.
- `signature_error`: client/appcast fixture rejects invalid signature metadata.
- `hosting_undecided`: appcast or artifact hosting URL is not owner-approved.
- `license_blocked`: gated release depends on #327 or entitlement state.

## Owner/Codex Handoff

When the owner is ready to execute this runbook, hand the Codex agent this
minimal packet:

```text
Source SHA:
Version:
Build:
Channel:
Developer ID identity:
Notary path: keychain profile name OR App Store Connect API-key env injection
Sparkle public key env:
Sparkle feed URL:
Artifact hosting URL:
Appcast hosting URL:
Evidence directory:
Rollback target:
License/update policy:
```

The agent should stop before signing if any required input is missing. The agent
should stop before publishing if appcast hosting, artifact hosting, rollback, or
license/update policy is undecided.

## Validation For This Document

The #322 PR is valid when:

- This runbook names the real command shapes without executing signing or
  notarization.
- Credential names match #324, but no credential values appear.
- The appcast lane points to #323 fixtures/dry-run generator and keeps signing
  and hosting owner-gated.
- The proof boundary says this is documentation only.
- Local doc validation and repo secret scan pass.
