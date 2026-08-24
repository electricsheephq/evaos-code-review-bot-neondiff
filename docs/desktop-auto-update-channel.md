# Desktop Auto-Update Channel

Issue #116 tracks NeonDiff Desktop's Sparkle 2 update channel with signed
artifacts, rollback, and license-aware entitlement checks. The native source now
contains the real Sparkle controller and release-build configuration gate. No
hosted appcast, signed update, installed update, rollback, or public release is
proven by source alone.

## Current Implementation — source main `1e4b54d` (2026-08-24)

- The native SwiftUI executable uses the existing Sparkle 2 dependency and
  standard updater UI in
  `apps/neondiff-desktop/Sources/NeonDiffDesktop/Support/NeonUpdateController.swift`.
- Every Release build requires a paired, nonblank HTTPS `SUFeedURL` and
  `SUPublicEDKey`; partial, hostless, whitespace-only, missing, or explicitly
  disabled configuration fails in
  `apps/neondiff-desktop/script/build_and_run.sh` before the bundle is built.
  This gate proves configuration shape and presence only; CI placeholders are
  never proof of the real release key or appcast identity.
- Configured builds check the beta feed every six hours and also expose a
  manual Check for Updates action. Downloads remain user-confirmed.
- Every check and every selected update re-evaluates update access. A paid/trial
  activation must explicitly include `updateEntitlement=true`, remain inside
  its server expiry, and have been verified within five minutes.
  A server `internal_admin` entitlement or verified managed public-free
  repository is accepted only when both the account catalog and authoritative
  repository visibility were verified within five minutes. Missing production
  composition, stale authority, or missing update entitlement fails closed. The
  policy and focused tests live in
  `DesktopUpdateAccess.swift` and `DesktopUpdateAccessPolicyTests.swift`.
- The customer UI distinguishes ready, checking, update available, up to date,
  entitlement required, invalid feed, network error, signature error, and
  generic safe failure.
- Failing-first tests in `DesktopUpdateAccessPolicyTests.swift` cover access
  policy, public-free bounds, stale paid/trial state, bounded account authority,
  update-specific entitlement, and Sparkle error classification. The existing
  appcast generator and rollback/signature fixtures remain the publishing seam.

Proof boundary: source composition and unsigned Release-configuration bundle
proof only. #116 remains open for real public-key/feed identity, EdDSA-signed
appcast, exact signed/notarized installed update, state-preserving rollback and
re-update, immutable release assets, and live customer evidence.

Sparkle 2 is the selected updater for the native SwiftUI path while #116 is
open. The #610 Mac GA boundary is stricter: the current public release manifest
does not include a signed native Desktop artifact, so fixtures or an unsigned
bundle cannot establish release, installed-update, rollback, or GA readiness.

## Durable Plan Contract

Set `NEONDIFF_EVIDENCE_ROOT` to an absolute external directory outside the checkout for
local packets (the source default is `$HOME/.neondiff/evidence`). Do not put
credentials, private keys, or customer data in that directory. Historical
release/evidence packets are immutable and are not rewritten by this plan.

- Goal: define the desktop auto-update channel contract for NeonDiff Desktop
  using the selected Sparkle 2 path without weakening release governance or
  license boundaries.
- Resume identity: repo `electricsheephq/evaos-code-review-bot-neondiff`, branch
  `codex/116-desktop-autoupdate-plan`, base
  `1e4b54d1d14f35fb2b22464c474f74cf1fa20b35`, issue
  https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/116,
  parent tracker
  https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103.
- Tracking / source of truth: GitHub issues and PRs own implementation truth;
  `docs/release-governance.md`, `docs/license-boundary.md`, and
  `docs/public-release-manifest.json` own current release and license wording;
  Notion/Company OS remains architecture and evidence routing; no live runtime
  or roadmap state is changed by this document.
- Scope / non-goals: no updater implementation, signing/notarization setup,
  private key material, appcast publication, installer distribution, license API
  implementation, launchd/runtime change, or claim that desktop auto-update is
  shipped.
- Current state: NeonDiff is a source-available beta; desktop update channels
  remain `post_1_0` and non-required in `docs/public-release-manifest.json`.
  The native source has a Sparkle 2 controller and Release configuration gate,
  but source/unsigned-bundle proof is not signed-feed or installed-update proof.
  Issue #111 owns license activation and #610 owns the Mac GA artifact boundary.
- Exact next action: implement and test the single promotion, containment, and
  rollback path required by `docs/architecture/mac-ga-release-contract.md`;
  only then run owner-gated #116/#322/#323 evidence from an exact candidate.
- Critical invariants: every downloaded gated artifact must be entitlement
  checked before download, signature verified before install, tied to a channel
  manifest, rollbackable to a last-known-good release, and backed by public-safe
  evidence that does not expose signing keys, license secrets, or customer data.
- Execution lanes: shell decision; update metadata schema; signing and key
  custody; license/update entitlement check; desktop UI and CLI status surface;
  rollback and kill-switch behavior; fixture-backed dry-run validation; release
  governance integration.
- Validation / eval gates:
  - Eval required: yes
  - Eval claim class: advisory
  - Required eval suites: updater dry-run using a local/static manifest,
    signature verification failure fixture, license entitlement allowed fixture,
    license entitlement blocked fixture, rollback channel fixture, and release
    manifest governance check.
  - Eval name/version: desktop-auto-update-channel-plan-v0.1
  - Dataset/scenario refs: issue #116 acceptance criteria, issue #111 license
    activation contract, issue #114 desktop shell audit, issue #112 release
    governance, and `docs/public-release-manifest.json`.
  - Baseline/comparison: current `post_1_0` deferred desktop channel in
    `docs/public-release-manifest.json`.
  - Metrics and thresholds: update check distinguishes no-update,
    update-available, blocked-by-license, network-error, and signature-error;
    invalid signatures never install; gated artifacts never download without a
    valid entitlement when policy requires one; rollback target resolves to a
    signed last-known-good release.
  - Runner/CI location: future GitHub Actions plus local evidence packet under
    `$NEONDIFF_EVIDENCE_ROOT/neondiff-desktop-auto-update/<date>/<run-id>/`.
  - Failure owner: desktop/update implementation owner for future PRs.
  - Eval evidence path:
    `$NEONDIFF_EVIDENCE_ROOT/neondiff-desktop-auto-update/<date>/<run-id>/`.
  - Trace feedback target: issue #116, the implementation PR, release notes,
    and the public release manifest.
  - Eval proof boundary: proves only planning readiness until implementation
    fixtures and signed artifact evidence exist; never proves shipped updater,
    customer readiness, release readiness, TCC readiness, notarization, or
    public download availability by itself.
- Proof-claim boundary: this document may be cited as the desktop update-channel
  governance plan. It must not be cited as evidence that Sparkle, Tauri updater,
  signing, entitlement checks, rollback, installer distribution, or UI status
  handling is implemented.
- Stop conditions: unresolved desktop shell choice; absent public-key strategy;
  signing or notarization secrets requested in repo or docs; entitlement policy
  unclear for public/private/commercial repos; update metadata cannot express
  rollback; update status cannot distinguish license, network, and signature
  failures; docs or release notes claim shipped updater before fixture evidence.
- Evidence path / packet:
  `$NEONDIFF_EVIDENCE_ROOT/neondiff-desktop-auto-update/<date>/<run-id>/` plus
  linked GitHub issue, PR, release, workflow run, and artifact identities.

## Channel Model

The desktop channel should be explicit in update metadata rather than inferred
from branch names, app names, or runtime config.

- `beta`: pre-stable desktop channel for fixture or signed candidate artifacts.
  Beta may be license-gated and must remain rollbackable; beta evidence never
  implies a public or GA release.
- `stable`: future channel for public-ready signed artifacts only after #116
  and the #610 immutable artifact/feed/install/rollback gates pass. Stable must
  not alias the beta feed.
- `disabled`: server-side or static-manifest state that makes the desktop report
  a clear no-update or channel-disabled result without attempting a download.
- `rollback`: pointer to the last-known-good signed version. Rollback metadata
  must include the target version, artifact identity, signature/public-key
  reference, reason, and operator contact or release-note link.

The manifest must never rely on mutable `latest` semantics alone. Each update
entry needs immutable version, source commit, artifact checksum, signature,
minimum desktop version when relevant, channel, entitlement requirement, release
notes URL, and rollback target.

## Signed Artifact Rules

The native SwiftUI path uses Sparkle 2. Any future replacement must provide
equivalent guarantees:

- artifacts are signed and verified before install
- public verification material may live in the repo, but private signing keys
  never do
- signature failure is a first-class status and cannot fall through to install
- update metadata is served over authenticated or integrity-protected transport
  appropriate to the chosen updater
- artifact identity is recorded in release notes and evidence packets
- signing, notarization, and updater keys are rotated or revoked through a
  documented operator path

Sparkle appcasts and EdDSA signatures are the selected production path. The
private signing key remains outside source control; only the public key may be
embedded in the app bundle.

## License-Aware Entitlement Checks

`docs/license-boundary.md` says auto-updates require an active paid NeonDiff
license. The updater must therefore fail closed when a gated artifact requires
entitlement proof and that proof is missing, expired, invalid, or unavailable.

Required behavior:

- public/free update policy is explicit in metadata and release notes
- private, commercial, binary, marketplace, or gated channels require entitlement
  before artifact download when policy requires it
- entitlement checks do not print license keys, tokens, email addresses, raw
  customer records, or signed entitlement payloads into logs or evidence
- temporary network failure reports `network-error`, not `blocked-by-license`
- invalid or missing entitlement reports `blocked-by-license`
- entitlement success permits download but does not bypass signature verification

The desktop UI and any CLI status surface should use the same state names:
`no-update`, `update-available`, `blocked-by-license`, `network-error`, and
`signature-error`.

## Release Governance Gates

Before #116 can close and the public manifest can claim a working desktop update
channel, the release lane must provide evidence for:

- desktop shell choice and updater technology
- signed artifact creation and public verification material
- local/static manifest dry run
- signature failure fixture
- license entitlement allowed and blocked fixtures
- rollback manifest fixture resolving to a signed last-known-good artifact
- release notes naming source commit, version, artifact identity, and rollback
  target
- public-safe evidence packet under `$NEONDIFF_EVIDENCE_ROOT/`

Until those gates exist, `docs/public-release-manifest.json` should keep desktop
updates non-required and explicitly linked to issue #116.

## Tracking

- Parent roadmap: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103
- Release governance: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/112
- License activation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/111
- Desktop shell audit: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/114
- Desktop app MVP: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/115
- This plan: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/116
