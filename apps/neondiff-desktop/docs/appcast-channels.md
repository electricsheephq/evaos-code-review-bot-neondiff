# NeonDiff Desktop 1.1.0 Appcast Channels

This document covers the repository-owned appcast generation and evidence lane
for NeonDiff Desktop `1.1.0`. The Desktop declaration/index and content-addressed
accepted packet own release identity; this document does not prove hosted feeds,
notarized artifacts, or real EdDSA signing.

## Channels

- `beta`: early or signed candidate builds for opted-in testers, using the beta
  product channel and beta feed ring; fixture output is not a public or GA
  release.
- `rc`: the RC product channel for `v1.1.0-rc.N`. Its retained Sparkle
  enclosure and enclosure-proof channel remain the observed `beta` feed ring;
  `rc` must not be relabeled as a beta product declaration.
- `stable`: final signed release builds using the stable product channel and
  stable feed ring, only after #116/#610 signed-feed, immutable-artifact,
  install, and rollback proof has passed.
- Rollback is represented by a stable feed whose newest marker pins the channel
  latest to an earlier stable version via `rollback_to`; the generated appcast
  excludes the superseded newer build so Sparkle cannot select it.

RC and stable declarations require a distinct annotated tag object whose
annotation contains exactly one line:

```text
NeonDiff-Release-Class: desktop-only
```

Issue #559 must first publish and provenance-bind immutable `neondiff@1.0.5`.
The Desktop-only npm no-op is not valid until the exact package manifest,
tarball, CLI, worker, integrity, provenance, and source identity are read back.
The marker does not bypass that package gate.

Executable update, rollback, identical-byte re-update, feed/publication, and
local-adoption commands remain blocked until #895 reaches `source-accepted`.
Use only the exact tested repository-owned transition command after that gate;
manual copy, source reset, rebuild, LaunchAgent restart, or ad hoc feed mutation
is not a supported substitute.

## Dry-Run Generator

Generate a local appcast from a committed fixture:

```sh
: "${NEONDIFF_EVIDENCE_ROOT:?set an external evidence root outside this checkout}"
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
mkdir "$RUN_DIR" || exit 2
"$REPO_ROOT/apps/neondiff-desktop/script/generate-appcast.sh" \
  --fixture fixtures/appcast/beta.json \
  --output "$RUN_DIR/appcast.xml" \
  --dry-run
```

Use the captured external `$RELEASE_DATE/$RUN_ID/` directory for every packet; `mkdir` must fail on reuse. This command does not read credentials or private-key paths.

Dry-run mode never signs, uploads, notarizes, or fabricates a real signature.
The `sparkle:edSignature` attribute appears only when the manifest explicitly
contains an `ed_signature`, such as the signature-failure fixture.

The generated XML follows Sparkle 2's appcast publishing model: beta and RC
enclosures use the item-level `sparkle:channel` element with `beta`, while
stable uses `stable`; EdDSA signatures live on the download enclosure as
`sparkle:edSignature`.

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

This lane proves channel modeling, RC-versus-beta feed-ring mapping, rollback
ordering, fixtures, and local appcast XML generation only. It does not prove
Sparkle client update success, signature verification, hosting, notarization,
public download readiness, transition execution, or GA readiness.
