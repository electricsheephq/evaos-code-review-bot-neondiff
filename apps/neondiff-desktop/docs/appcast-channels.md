# NeonDiff Desktop Appcast Channels

This document covers the buildable appcast generation lane for NeonDiff Desktop.
It does not prove hosted feeds, notarized artifacts, or real EdDSA signing.
Sparkle 2 is the selected production updater, but #116 and the #610 Mac GA
artifact gates remain open.

## Channels

- `beta`: early or signed candidate builds for opted-in testers; fixture output
  is not a public or GA release.
- `stable`: future signed release builds only after #116 and #610 signed-feed,
  immutable-artifact, install, and rollback proof has passed.
- Rollback is represented by a stable feed whose newest marker pins the channel
  latest to an earlier stable version via `rollback_to`; the generated appcast
  excludes the superseded newer build so Sparkle cannot select it.

## Dry-Run Generator

Generate a local appcast from a committed fixture:

```sh
: "${NEONDIFF_EVIDENCE_ROOT:?set an external evidence root outside this checkout}"
case "$NEONDIFF_EVIDENCE_ROOT" in /*) ;; *) echo "NEONDIFF_EVIDENCE_ROOT must be absolute" >&2; exit 2 ;; esac
RUN_ID="<caller-supplied-unique-run-id>"
RUN_DIR="$NEONDIFF_EVIDENCE_ROOT/neondiff-desktop/$(date +%F)/$RUN_ID"
mkdir -p "$(dirname "$RUN_DIR")"
mkdir "$RUN_DIR"
apps/neondiff-desktop/script/generate-appcast.sh \
  --fixture fixtures/appcast/beta.json \
  --output "$RUN_DIR/appcast.xml" \
  --dry-run
```

The output root is operator-owned, absolute, and external to the checkout; use
a fresh `<date>/<run-id>/` directory for every packet. `mkdir` must fail on
reuse. This command does not read credentials or private-key paths.

Dry-run mode never signs, uploads, notarizes, or fabricates a real signature.
The `sparkle:edSignature` attribute appears only when the manifest explicitly
contains an `ed_signature`, such as the signature-failure fixture.

The generated XML follows Sparkle 2's appcast publishing model: beta releases
use the item-level `sparkle:channel` element, and EdDSA signatures live on the
download enclosure as `sparkle:edSignature`.

## Dry-Run Status Taxonomy

The appcast core models these update outcomes for fixtures and release evidence:

- `no_update`
- `update_available`
- `blocked_by_license`
- `network_error`
- `signature_error`
- `feed_invalid`
- `unsupported_channel`

These statuses back both dry-run planning and the native updater UI. The source
maps real Sparkle no-update, network/feed, signature/validation, cancellation,
and generic failures into distinct customer states. The current generator does
not reject invalid or missing `rollback_to`; release validation must catch it
before publishing. A hosted signed appcast and installed-app run are still
required before claiming runtime or GA proof.

## Fixtures

Fixtures live under `apps/neondiff-desktop/fixtures/appcast/`:

- `beta.json`: beta-channel appcast.
- `stable.json`: stable-channel appcast.
- `rollback.json`: stable rollback feed that pins latest to a prior version.
- `signature-failure.json`: intentionally invalid signature metadata for the
  client-side failure story.
- `stale-version.json`: stale-version fixture for release checks.
- `license-blocked.json`: private/update entitlement fixture for later license
  service integration.

## Signing Seam

Real appcast signing remains a release-time step. It fills `ed_signature` from
Sparkle's `sign_update` output using owner-custodied private key material.
Private key values must never be committed, logged, or written to evidence.

The public key and feed URL are build-time inputs documented in
`signing-credentials.md`; the current generator only creates local XML from
manifest metadata.

## References

- Sparkle publishing guide: `https://sparkle-project.org/documentation/publishing/`
- Sparkle updater delegate channel API: `https://sparkle-project.org/documentation/api-reference/Protocols/SPUUpdaterDelegate.html`

## Proof Boundary

This lane proves channel modeling, rollback ordering, fixtures, and local
appcast XML generation only. It does not prove Sparkle client update success,
signature verification, hosting, notarization, public download readiness, or GA
readiness.
