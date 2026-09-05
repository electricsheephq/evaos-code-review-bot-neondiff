# NeonDiff Desktop 1.1.0 Mac Release Runbook

This is the repository-owned checklist for the NeonDiff Desktop `1.1.0` GA
release path: accepted declaration and packet resolution, private candidate
construction, signing/notarization evidence, appcast evidence, and redacted
handoff. The authoritative release identity is the append-only Desktop
declaration history at `docs/releases/desktop/index.json` and its referenced
declarations. The accepted packet and artifact-source attestation are the
authorities for the exact bytes; a checkout, current Actions artifact, mutable
feed, or installed app is not a substitute.

The release owner must preserve the ordered `#610` path: #559 first publishes
and provenance-binds immutable `neondiff@1.0.5`, #116 owns the signed updater
outcome, and #895 is the sole repository-owned update/rollback implementation.
This document does not itself prove a signed artifact, notarization, feed
publication, installed update, runtime adoption, customer readiness, or GA.

**TRANSITION GATE:** executable update, rollback, identical-byte re-update,
feed/publication, and local-adoption commands remain blocked until #895 reaches
`source-accepted` with its exact-head CI, review, and acceptance evidence. Private
development/staging proof and declared artifact construction may proceed in an
isolated environment without modifying an existing installation or public surface.
Resolve construction inputs and credentials first; collect artifact verification
and accepted promotion evidence afterward. Manual copy, source reset, rebuild, LaunchAgent
restart, database edit, or ad hoc feed mutation is not a supported substitute.

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
| Customer readiness | Owner-approved release notes, license/update policy, hosting, rollback, and support handoff are recorded. | Stop if the customer-facing entitlement/update policy is unresolved for the chosen channel. |

## Release identity and package gate

For every RC or stable candidate, resolve the fixed Desktop tag from the
accepted declaration and require a distinct annotated tag object. Its annotation
must contain exactly one line:

```text
NeonDiff-Release-Class: desktop-only
```

The RC product channel is `rc`; its retained Sparkle enclosure and enclosure
proof remain on the observed `beta` feed ring. Stable uses product channel and
feed ring `stable`. Before construction, bind the accepted declaration, exact
channel, tag object, peeled source commit, package, intended feed, and logical
credential profile. Verify actual artifact/tree/signature/notary identities after
construction. Before promotion, require the complete accepted packet, attestation,
real-test evidence, and exact artifact/tree/feed agreement. The final packet is
not a prerequisite for constructing the bytes needed to produce that evidence.

Before any RC or stable declaration, signing, or notarization, #559 must have published
immutable `neondiff@1.0.5` and a fresh registry readback must prove its exact
manifest, tarball, CLI, worker, integrity, provenance, and source identity.
The Desktop-only npm classification is a no-op for the Desktop release only
after this package identity gate is satisfied; the marker never proves
unchanged CLI/worker bytes and never bypasses #559.

A redundant `release-candidate` alias resolving to the same verified `1.0.5`
does not block private staging or construction. Keep cleanup and strict typed
#559 closure open until proven; both remain required before public GA.

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
`not affected` for non-desktop PRs, and it should run the Swift Core/AppCore
tests, fixture checks, Swift build, app bundle build, and bundle check for
desktop-affecting PRs. The hosted gate requires nonzero execution of
`NeonDiffDesktopCoreTests` and `NeonDiffDesktopAppCoreTests` through
`scripts/run-required-swift-test-suite.sh`, and runs
`NeonDiffDesktopFixtureChecks`. Run `NeonDiffDesktopCoreSmoke` and click through
the visible UI in the local or release-smoke lane where an interactive session
exists. The path-aware Swift
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
   `dist/NeonDiff.app` path passed to Computer Use.
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

Set the external evidence root once for this run (default `$HOME/.neondiff/evidence`).
Keep packets immutable and secret-free. Run every following `sh` block in this
same shell; sections anchor to `$REPO_ROOT`. If state is lost, restart with a new `RUN_ID`:

```sh
export NEONDIFF_EVIDENCE_ROOT="${NEONDIFF_EVIDENCE_ROOT:-$HOME/.neondiff/evidence}"
case "$NEONDIFF_EVIDENCE_ROOT" in /*) ;; *) echo "NEONDIFF_EVIDENCE_ROOT must be absolute" >&2; exit 2 ;; esac
test -d "$NEONDIFF_EVIDENCE_ROOT" || { echo "create the external evidence root first" >&2; exit 2; }
NEONDIFF_EVIDENCE_ROOT="$(cd "$NEONDIFF_EVIDENCE_ROOT" && pwd -P)" || { echo "cannot canonicalize evidence root" >&2; exit 2; }
REPO_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" || { echo "cannot canonicalize checkout root" >&2; exit 2; }
case "$NEONDIFF_EVIDENCE_ROOT/" in "$REPO_ROOT/"*) echo "evidence root must be outside the checkout" >&2; exit 2 ;; esac
RELEASE_DATE="$(date +%F)" || { echo "cannot capture release date" >&2; exit 2; }; case "$RELEASE_DATE" in [0123456789][0123456789][0123456789][0123456789]-[0123456789][0123456789]-[0123456789][0123456789]) ;; *) echo "RELEASE_DATE must use YYYY-MM-DD" >&2; exit 2 ;; esac; : "${RUN_ID:?set a unique portable RUN_ID}"; case "$RUN_ID" in ""|"."|".."|*[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._-]*) echo "RUN_ID must be a portable path segment" >&2; exit 2 ;; esac
PACKET_ROOT="$NEONDIFF_EVIDENCE_ROOT/neondiff-desktop"
test -e "$PACKET_ROOT" || mkdir "$PACKET_ROOT" || exit 2
PACKET_ROOT="$(cd "$PACKET_ROOT" && pwd -P)" || { echo "cannot canonicalize evidence packet root" >&2; exit 2; }
case "$PACKET_ROOT/" in "$NEONDIFF_EVIDENCE_ROOT/"*) ;; *) echo "evidence packet root escaped evidence root" >&2; exit 2 ;; esac
case "$PACKET_ROOT/" in "$REPO_ROOT/"*) echo "evidence packet root must be outside the checkout" >&2; exit 2 ;; esac
RUN_PARENT="$PACKET_ROOT/$RELEASE_DATE"
test -e "$RUN_PARENT" || mkdir "$RUN_PARENT" || exit 2
RUN_PARENT="$(cd "$RUN_PARENT" && pwd -P)" || { echo "cannot canonicalize evidence packet parent" >&2; exit 2; }
case "$RUN_PARENT/" in "$PACKET_ROOT/"*) ;; *) echo "evidence packet parent escaped packet root" >&2; exit 2 ;; esac
case "$RUN_PARENT/" in "$REPO_ROOT/"*) echo "evidence packet parent must be outside the checkout" >&2; exit 2 ;; esac
RUN_DIR="$RUN_PARENT/$RUN_ID"
mkdir "$RUN_DIR" || exit 2; cd "$REPO_ROOT" || exit 2
```

```sh
apps/neondiff-desktop/script/preflight-credentials.sh
apps/neondiff-desktop/script/preflight-credentials.sh --json \
  > "$RUN_DIR/credential-preflight.json"
```

The doctor reports presence only. It does not sign, notarize, upload, fetch
artifacts, or print secret values. Canonical credential names and custody rules
live in `apps/neondiff-desktop/docs/signing-credentials.md`.

Credential presence never bypasses the immutable package gate above. Do not
declare, tag, sign, notarize, or stage a candidate while #559's `1.0.5`
manifest, tarball, CLI, worker, integrity, provenance, and source readback is
missing or disagrees with the accepted source.

Required owner/Codex inputs for a real signing run:

- A passing pre-signing #524 development/staging receipt at the exact candidate
  source and registry package: clean internal macOS 15 host, supported setup,
  account/bot/repository/entitlement/configuration/worker agreement, truthful
  readiness, and one dry review without hidden repair. Missing or failed proof
  blocks Developer ID signing and notarization; never use the operations app.
- Exact accepted declaration, source SHA, annotated tag and tag-object SHA,
  version, build, product channel, and logical credential profile. The final
  accepted packet digest is collected after artifact verification and required
  real tests, before promotion; it is not a signing input.
- Fresh #559 registry readback for immutable `neondiff@1.0.5`.
- Unique portable `RUN_ID` for this immutable evidence packet.
- Developer ID Application identity name, for example
  `Developer ID Application: <Team Name> (<TEAMID>)`.
- Notarization path: either `NEONDIFF_NOTARY_KEYCHAIN_PROFILE` or the approved
  App Store Connect API-key environment described in `signing-credentials.md`.
- Sparkle public key as `NEONDIFF_SPARKLE_PUBLIC_ED_KEY`.
- Sparkle feed URL as `NEONDIFF_SPARKLE_FEED_URL`.
- Appcast hosting destination and rollback destination.
- Evidence packet directory under `$NEONDIFF_EVIDENCE_ROOT/`.

## Build The Release App

After the declaration and package gates pass, set the exact bundle version and
build number before creating the private candidate bundle.
The bundle id is `com.electricsheephq.NeonDiffDesktop`; the minimum supported
macOS version is 14.0.

```sh
cd "$REPO_ROOT/apps/neondiff-desktop"
export NEONDIFF_DESKTOP_VERSION="<version>"
export NEONDIFF_DESKTOP_BUILD="<build>"
export NEONDIFF_SPARKLE_PUBLIC_ED_KEY="<owner-provided-public-key>"
export NEONDIFF_SPARKLE_FEED_URL="<owner-approved-feed-url>"

script/build_and_run.sh release-build
script/build_and_run.sh release-bundle-check
```

Expected output artifact:

```text
apps/neondiff-desktop/dist/NeonDiff.app
```

Record the bundle metadata and checksum:

```sh
/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" dist/NeonDiff.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" dist/NeonDiff.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" dist/NeonDiff.app/Contents/Info.plist
/usr/libexec/PlistBuddy -c "Print :NeonDiffSourceSHA" dist/NeonDiff.app/Contents/Info.plist
shasum -a 256 dist/NeonDiff.app/Contents/MacOS/NeonDiffDesktop
```

The printed `NeonDiffSourceSHA` must equal the detached checkout's exact
`git rev-parse HEAD`. The release build derives it internally and fails on a
dirty checkout; never supply or patch this marker as caller text.

Do not ship a dev/ad-hoc artifact from this step. The build is only a candidate
until the signing, notarization, stapling, Gatekeeper, and appcast evidence below
all pass.

## Codesign

Sign the sealed worker with its minimal Node JIT entitlements, then the embedded
framework when it exists, and finally the outer app. Do not use `--deep` to
replace the already-reviewed nested signatures.

```sh
cd "$REPO_ROOT/apps/neondiff-desktop"
IDENTITY="Developer ID Application: <Team Name> (<TEAMID>)"
APP="dist/NeonDiff.app"
SPARKLE_FRAMEWORK="$APP/Contents/Frameworks/Sparkle.framework"
SEALED_WORKER="$APP/Contents/Helpers/NeonDiffWorker"
WORKER_ENTITLEMENTS="script/worker-runtime.entitlements.plist"

codesign --force --options runtime --timestamp \
  --entitlements "$WORKER_ENTITLEMENTS" \
  --sign "$IDENTITY" "$SEALED_WORKER"

if [ -d "$SPARKLE_FRAMEWORK" ]; then
  codesign --force --options runtime --timestamp --sign "$IDENTITY" "$SPARKLE_FRAMEWORK"
fi

codesign --force --options runtime --timestamp --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -d --entitlements :- "$SEALED_WORKER"
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
the notarization paths documented in `signing-credentials.md`.

```sh
cd "$REPO_ROOT/apps/neondiff-desktop"
APP="dist/NeonDiff.app"
ZIP="$RUN_DIR/NeonDiff.zip"

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

Use the committed appcast fixtures and generator as the local appcast model.
The generator creates local XML only; it does not sign, upload, or fabricate a
real Sparkle signature. See `appcast-channels.md` for the product-channel and
feed-ring contract.

```sh
"$REPO_ROOT/apps/neondiff-desktop/script/generate-appcast.sh" \
  --fixture fixtures/appcast/beta.json \
  --output "$RUN_DIR/appcast.xml" \
  --dry-run
```

For a real release appcast, update the manifest metadata with the hosted artifact
URL, version/build, release notes URL, channel, minimum system version, checksum,
and Sparkle EdDSA signature. The EdDSA signature must come from Sparkle's
`sign_update` using owner-custodied private key material. Never commit, log, or
write the Sparkle private key to evidence.

The owner must choose and document the appcast hosting URL and artifact hosting
URL before publishing any feed. The feed URL must match the
`NEONDIFF_SPARKLE_FEED_URL` baked into the signed app.

Do not publish an RC or stable feed, product release, or public artifact from
this documentation lane before #895 is `source-accepted` and the relevant
release authority has been recorded. After that gate, use only the exact tested
repository-owned command supplied by #895; never assemble a transition from
these snippets or from a mutable live feed.

Distinguish authorized immutable artifact hosting from accepted promotion:
the packet producer consumes an existing non-draft immutable GitHub release.
After private signed-byte testing and #895 source acceptance, a separately
authorized artifact-hosting release may supply those exact bytes while the
feed/site/download promotion remains held. That hosting action is public and
must be reported; it is not private staging, an accepted packet, or GA.
Complete #1093's protected-declaration and feed/packet ordering checks before
dispatching its workflow; this document does not certify that workflow ready.

Rollback proof:

- Generate or reference the committed rollback fixture/appcast.
- Record the rollback target version, build, channel, artifact URL, checksum,
  release-note URL, and reason.
- Confirm the rollback appcast excludes the superseded newer build.

Signature-failure proof:

- Reference the committed signature-failure fixture and evidence.
- Confirm the expected client-side status is `signature_error`.
- Do not treat the dry-run fixture as real Sparkle client proof; real client
  signature failure requires a signed/notarized app and hosted appcast.

License boundary:

- Private/gated update behavior depends on the approved production entitlement
  service and channel declaration. Until that service is live and enabled for
  the channel, release notes must say whether updates are public, gated, or
  intentionally deferred.

## Evidence Packet

Create a public-safe packet under:

```text
$RUN_DIR/
```

Minimum files collected across the completed release gates, not prerequisites
for construction. Record missing later-gate evidence as pending; never fabricate
a packet or treat a construction receipt as promotion approval:

- `source.txt`: repo, branch, source SHA, annotated tag and tag-object SHA,
  version, build, product channel, feed ring, operator, UTC timestamp, and,
  when CI-built, workflow run URL plus artifact ID/name.
- `declaration.json`: exact accepted Desktop declaration and index readback.
- `pre-signing-product-smoke.md`: the passing source/package-bound #524 setup,
  readiness/alignment and dry-review receipt required before signing.
- `accepted-packet.json`: content-addressed accepted packet and its digest.
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
- `license_blocked`: gated release depends on an unresolved entitlement state.
- `package_identity_blocked`: #559 registry/provenance readback is missing or
  differs from the candidate package bytes.
- `transition_blocked`: #895 is not yet `source-accepted`, or its exact tested
  command and live acceptance evidence are absent.

## Owner/Codex Handoff

When the owner is ready to execute this runbook, hand the Codex agent this
minimal packet:

```text
Accepted declaration:
Accepted packet digest (after verification/tests, before promotion):
Source SHA:
Annotated tag / tag-object SHA:
Version / build:
Product channel / feed ring:
Registry package: neondiff@1.0.5 readback
Developer ID identity:
Notary path: keychain profile name OR approved App Store Connect API-key env injection
Sparkle public key env:
Sparkle feed URL:
Artifact hosting URL:
Appcast hosting URL:
Evidence directory:
Rollback target:
License/update policy:
```

The agent should stop before signing if any construction input above is missing;
the final accepted packet is later-gate evidence, not a construction input. The agent
should stop before publishing if appcast hosting, artifact hosting, rollback, or
license/update policy is undecided.

## Validation For This Document

This document is complete for the release lane when:

- The declaration and accepted packet are the named release authorities.
- RC/stable tags, the exact `NeonDiff-Release-Class: desktop-only` marker, and
  the #559 package identity gate are explicit.
- Credential checks are presence-only and never contain values.
- The appcast lane distinguishes RC product channel `rc` from the `beta` feed
  ring and keeps signing/hosting owner-gated.
- Transition commands are explicitly blocked until #895 `source-accepted`.
- The proof boundary says this is documentation and handoff guidance only.
- Local doc validation and repo secret scan pass.
