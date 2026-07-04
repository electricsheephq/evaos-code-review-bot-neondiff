# Desktop Auto-Update Channel Plan

Issue #116 tracks the future NeonDiff Desktop auto-update channel with signed
artifacts, rollback, and license-aware entitlement checks. This document is a
planning and governance contract only. It does not ship an updater, publish an
appcast, enable artifact downloads, change live runtime config, or prove desktop
release readiness.

## Durable Plan Contract

- Goal: define the desktop auto-update channel contract for NeonDiff Desktop so
  future implementation can choose Sparkle, Tauri updater, or an equivalent
  signed updater without weakening release governance or license boundaries.
- Resume identity: repo `electricsheephq/evaos-code-review-bot`, branch
  `codex/116-desktop-autoupdate-plan`, base
  `1e28bf8ee0bfe42d0a7f3cc47ed76508497efe96`, issue
  https://github.com/electricsheephq/evaos-code-review-bot/issues/116, parent
  tracker https://github.com/electricsheephq/evaos-code-review-bot/issues/103.
- Tracking / source of truth: GitHub issues and PRs own implementation truth;
  `docs/release-governance.md`, `docs/license-boundary.md`, and
  `docs/public-release-manifest.json` own current release and license wording;
  Notion/Company OS remains architecture and evidence routing; no live runtime
  or roadmap state is changed by this document.
- Scope / non-goals: no updater implementation, no Sparkle or Tauri dependency
  selection, no signing/notarization setup, no private key material, no appcast
  publication, no installer distribution, no license API implementation, no
  launchd/runtime change, and no claim that desktop auto-update is shipped.
- Current state: NeonDiff is a source-available beta; desktop update channels
  are marked `post_1_0` and non-required in `docs/public-release-manifest.json`;
  `docs/neondiff-desktop.md` describes a development-only unsigned desktop
  scaffold; issue #111 owns license activation and issue #114 owns the legacy
  desktop shell audit.
- Exact next action: after desktop shell choice and license activation design
  are settled, create an implementation issue or PR that wires a signed local or
  static update-manifest dry run before any public appcast or artifact channel.
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
    `/Volumes/LEXAR/Codex/evidence/neondiff-desktop-auto-update/<date>/`.
  - Failure owner: desktop/update implementation owner for future PRs.
  - Eval evidence path:
    `/Volumes/LEXAR/Codex/evidence/neondiff-desktop-auto-update/<date>/`.
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
  `/Volumes/LEXAR/Codex/evidence/neondiff-desktop-auto-update/<date>/` plus
  linked GitHub issue, PR, release, workflow run, and artifact identities.

## Channel Model

The desktop channel should be explicit in update metadata rather than inferred
from branch names, app names, or runtime config.

- `beta`: pre-stable desktop channel for signed test artifacts and release
  candidates. Beta may be license-gated and must remain rollbackable.
- `stable`: future channel for public-ready signed artifacts after beta evidence
  proves update checks, entitlement behavior, signature failure handling, and
  rollback.
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

Future implementation may use Sparkle, Tauri updater, or another updater only if
it provides equivalent guarantees:

- artifacts are signed and verified before install
- public verification material may live in the repo, but private signing keys
  never do
- signature failure is a first-class status and cannot fall through to install
- update metadata is served over authenticated or integrity-protected transport
  appropriate to the chosen updater
- artifact identity is recorded in release notes and evidence packets
- signing, notarization, and updater keys are rotated or revoked through a
  documented operator path

If the final shell is the SwiftUI desktop path, Sparkle-style appcast and EdDSA
signatures are the likely default. If the final shell is Tauri, the Tauri updater
contract may replace Sparkle if it preserves signature verification, channel
metadata, rollback, and entitlement checks.

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

Before any desktop updater can be marked required in
`docs/public-release-manifest.json`, a future PR must provide evidence for:

- desktop shell choice and updater technology
- signed artifact creation and public verification material
- local/static manifest dry run
- signature failure fixture
- license entitlement allowed and blocked fixtures
- rollback manifest fixture resolving to a signed last-known-good artifact
- release notes naming source commit, version, artifact identity, and rollback
  target
- public-safe evidence packet under `/Volumes/LEXAR/Codex/evidence/`

Until those gates exist, `docs/public-release-manifest.json` should keep desktop
updates non-required and explicitly linked to issue #116.

## Tracking

- Parent roadmap: https://github.com/electricsheephq/evaos-code-review-bot/issues/103
- Release governance: https://github.com/electricsheephq/evaos-code-review-bot/issues/112
- License activation: https://github.com/electricsheephq/evaos-code-review-bot/issues/111
- Desktop shell audit: https://github.com/electricsheephq/evaos-code-review-bot/issues/114
- Desktop app MVP: https://github.com/electricsheephq/evaos-code-review-bot/issues/115
- This plan: https://github.com/electricsheephq/evaos-code-review-bot/issues/116
