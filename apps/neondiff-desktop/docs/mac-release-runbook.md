# NeonDiff Desktop Mac Release Runbook

This is the handoff-grade runbook for building, signing, notarizing, stapling,
validating, and recording evidence for a NeonDiff Desktop macOS artifact. It is
a release-execution checklist for the owner and a Codex agent once the missing
Apple/Sparkle inputs are available.

Proof boundary: this document closes the #322 documentation lane only. It does
not prove a signed artifact exists, does not submit anything to Apple, does not
publish an appcast, and does not make the desktop update channel GA-ready.
Parent issue #116 owns the signed auto-update channel, #323 owns appcast
fixtures/dry-run generation, #324 owns credential naming/custody, #325 owns the
desktop onboarding wizard, #327 owns production license-service deployment, and
the roadmap handoff index is #374.

## Release State Gates

Keep these release states independent. Passing one state never implies the next
state is complete.

| State | Proof | Stop condition |
| --- | --- | --- |
| Dev smoke | Source checkout builds and the local `.app` bundle launches or passes a local smoke/bundle check. | Stop if the app cannot build, launch, or pass `bundle-check`. This is not signing or release proof. |
| Staging artifact | A candidate `.app` or CI artifact is tied to the exact source SHA, version, build, checksum, and workflow run/artifact ID when CI-built. | Stop if artifact provenance is missing, mutable, or not tied to the intended source. |
| Signed/notarized proof | Developer ID signing, notarization acceptance, stapling, post-staple `codesign`, and `spctl` all pass on the same artifact. | Stop on any signing, notarization, stapling, or Gatekeeper failure. |
| Updater/feed proof | The appcast references the exact hosted artifact, includes the EdDSA signature, and has rollback/signature-failure evidence. | Stop if hosting is undecided, feed URL does not match the app, signature is missing, or rollback is unresolved. |
| TCC proof | A final signed/notarized artifact is used for any Accessibility, Screen Recording, microphone, or other TCC acceptance proof. | Stop if proof comes from an unsigned/ad-hoc app or a different signing identity. |
| Customer readiness | Owner-approved release notes, license/update policy, hosting, rollback, and support handoff are recorded. | Stop if #327 or any customer-facing entitlement/update policy is unresolved for the chosen channel. |

## Fast Desktop Iteration Before Release

Use the fastest proof loop that covers the changed behavior before entering the
release lane.

- Swift model, parser, command-builder, daemon-status, onboarding, or license
  setup changes: run `swift run NeonDiffDesktopCoreSmoke`.
- SwiftUI or app wiring changes: run the core smoke, `swift build`,
  `script/build_and_run.sh build`, and `script/build_and_run.sh bundle-check`.
- Browser, website, renderer, public docs, or config-only changes: use a
  preview server/browser smoke or focused Node tests first; do not run Swift
  locally unless the changed contract crosses into `apps/neondiff-desktop/`.
- Review-response commits that only change docs, release notes, or GitHub
  metadata should not restart local Swift work. Preserve the running remote gate
  and batch remaining feedback before the next push.

The CI `Swift desktop gate` is intentionally always-reporting. It should say
`not affected` for non-desktop PRs, and it should compile the Swift core checks
target, run Swift build, app bundle build, and bundle check for
desktop-affecting PRs. Execute `NeonDiffDesktopCoreChecks`, run
`NeonDiffDesktopCoreSmoke`, and click through the visible UI in the local or
release-smoke lane where an interactive session exists. The path-aware Swift
CodeQL workflow is a release/security scan. It should run for
desktop/signing/appcast/release paths through weekly schedule or manual dispatch
against the intended release ref; it should not be the inner product iteration
loop. The durable trigger, upload, timeout, and release-ref policy is
`docs/swift-codeql-policy.md`.

### Visible Desktop UI Smoke

Use a visible local smoke whenever the changed behavior is in onboarding,
provider setup, daemon controls, license entry, update-channel selection, or
other SwiftUI/AppKit wiring. This is a separate proof lane:

- CI artifact smoke: hosted runner builds an unsigned app bundle and metadata;
  it does not open the UI.
- Local visible smoke: launch the built `.app`, inspect the window with
  Computer Use or equivalent UI evidence, click the changed flow, and record the
  observed state.
- Signed/notarized release proof: owner-gated release credentials, signing,
  notarization, stapling, Gatekeeper, updater, and installed-app checks on the
  exact candidate artifact.

Minimum local visible-smoke checklist:

1. Run `script/build_and_run.sh run` from `apps/neondiff-desktop/`.
2. Record the source SHA and built app path, including the exact
   `dist/NeonDiffDesktop.app` path passed to Computer Use.
3. Record `Welcome visible`: the Welcome screen is present in the launched app.
4. Navigate to the changed step.
5. Record `changed button/action clicked`: click the changed button/action.
6. Capture the expected disabled, error, or success state.
7. For the onboarding baseline, confirm `Continue advanced from Welcome` and
   the Provider step blocks continuation with `Provider key missing` until a
   key is stored.
8. Name `credential-gated steps` that were not exercised because a provider
   key, license key, signing credential, or owner approval was absent.
9. Link the evidence from the PR or issue before merge.

Prefer one local build/run per logical batch. Do not spend a Swift build cycle
after every small review-response edit when the current built app already covers
the changed behavior.

A build-only Swift pass is not visible UI proof. If the PR changes SwiftUI or
desktop onboarding behavior and the evidence packet has no opened-window
screenshot, accessibility tree, or equivalent Computer Use state, the desktop
product proof is incomplete.

## Preconditions

Run every command from a fresh checkout of
`electricsheephq/evaos-code-review-bot-neondiff` pinned to the intended release
source SHA or immutable tag. Capture the release ref first, then detach the
checkout before any build:

```sh
RELEASE_SOURCE_REF="<sha-or-tag>"
git fetch origin main --tags
git checkout --detach "$RELEASE_SOURCE_REF"
git status --short
git rev-parse HEAD
```

Stop if the checkout is dirty, cannot resolve `RELEASE_SOURCE_REF`, resolves to
the wrong source SHA, or carries unrelated local changes. Do not sign whatever
`main` happens to point at during release execution.

Before building, run the read-only credential doctor:

```sh
apps/neondiff-desktop/script/preflight-credentials.sh
apps/neondiff-desktop/script/preflight-credentials.sh --json \
  > /Volumes/LEXAR/Codex/evidence/neondiff-desktop/<date>/<version>/credential-preflight.json
```

The doctor reports presence only. It does not sign, notarize, upload, fetch
artifacts, or print secret values. Canonical credential names and custody rules
live in `apps/neondiff-desktop/docs/signing-credentials.md`.

Known handoff gap recorded on #322: this machine was reported to have a Developer ID
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
  bundle id, channel, operator, UTC timestamp, and, when CI-built, workflow run
  URL plus artifact ID/name.
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
