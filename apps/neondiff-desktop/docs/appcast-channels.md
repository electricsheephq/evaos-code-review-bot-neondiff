# NeonDiff Desktop Appcast Channels

This document covers the buildable appcast generation lane for NeonDiff Desktop.
It does not prove hosted feeds, notarized artifacts, or real EdDSA signing.

## Channels

- `beta`: early desktop builds for opted-in testers.
- `stable`: signed release builds after the Mac release runbook has passed.
- Rollback is represented by a stable feed whose newest marker pins the channel
  latest to an earlier stable version via `rollback_to`.

## Dry-Run Generator

Generate a local appcast from a committed fixture:

```sh
apps/neondiff-desktop/script/generate-appcast.sh \
  --fixture fixtures/appcast/beta.json \
  --output /tmp/neondiff-beta-appcast.xml \
  --dry-run
```

Dry-run mode never signs, uploads, notarizes, or fabricates a real signature.
The `sparkle:edSignature` attribute appears only when the manifest explicitly
contains an `ed_signature`, such as the signature-failure fixture.

The generated XML follows Sparkle 2's appcast publishing model: beta releases
use the item-level `sparkle:channel` element, and EdDSA signatures live on the
download enclosure as `sparkle:edSignature`.

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

Real appcast signing is parked until the signed/notarized artifact and owner
credentials are available. The future signing step should fill `ed_signature`
from Sparkle's `sign_update` output using owner-custodied private key material.
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
