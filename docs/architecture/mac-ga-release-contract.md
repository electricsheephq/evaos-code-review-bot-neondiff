# NeonDiff Mac GA architecture and release contract

Status: declarative contract; implementation and evidence gated. This document
defines authorities, required evidence, and invariants. It is not a promotion
implementation, operator runbook, or proof that a release is ready.

## Scope and product boundaries

The Mac product is a native Desktop UI over the existing local agent and Codex
runtime. The UI does not become a second review engine or a second source of
release truth. Its supported service boundaries are:

- Desktop UI and its local status/configuration surface.
- The authoritative account and current-launch entitlement service. A stale
  checkout, cached license, or generic process health signal is not entitlement.
- Keychain-only provider, license, GitHub user-token, and activation secrets.
- The existing local review agent and customer-owned (BYO) GitHub App path,
  kept separate from any managed account path.
- Codex runtime integration, issue enrichment, billing, and activation, each
  with independently attributable account evidence.
- Signed distribution, feed metadata, updater behavior, and explicit beta and
  stable rings.

The native Desktop version line is `1.1.0`; the npm CLI remains `1.0.4` unless
its bytes change. The Desktop-only npm policy from merged PR #831 is a
dependency and does not by itself prove a Desktop artifact, publication, or
customer readiness.

## Runtime identities and authorities

The installed Desktop wrapper is
`/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop`. It must launch the
sealed helper
`/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker`; wrapper and helper
identity and digest are separate required facts.

The local worker LaunchAgent identity is the exact label
`com.electricsheephq.evaos-code-review-bot`. Its complete parsed contract,
including program, arguments, account/device placeholders, and absence of
environment variables or unexpected keys, is release evidence. Operator
account-scoped config and device values remain private and are never copied
into public evidence.

Authority is layered:

1. Source, pull request, review, and CI establish what was proposed and tested.
2. An accepted artifact packet establishes the exact immutable bytes approved
   for promotion.
3. Installed-runtime evidence establishes what wrapper and helper are present.
4. Account/current-launch entitlement establishes who may use the launch.
5. Fleet and customer evidence establishes observed adoption and outcomes.

No layer may be substituted for another. In particular, a source checkout,
build output, running process, or account-independent health page cannot prove
the current launch entitlement or installed release identity.

## Immutable accepted evidence packet

Every candidate and promotion decision names one immutable packet containing:

- source commit SHA and immutable Git tag;
- candidate artifact ZIP SHA-256, separately from the staged app
  `sha256-tree-v1` tree digest;
- codesigning Team ID, bundle identifier, version, and build;
- notarization receipt, stapling receipt, and Gatekeeper assessment;
- feed/appcast signature and the channel manifest identity;
- review receipt, CI receipt, and exact accepted-head relationship;
- account-scoped config path, state DB identity, and monitored-repository
  allowlist identity;
- LaunchAgent label and complete parsed identity, plus wrapper and sealed-helper
  identities and their digests.

The packet is redacted, account-bound, and immutable. It contains references to
secrets rather than secret values. ZIP identity and staged-tree identity must
both match the accepted packet; one is not a substitute for the other.

## Gates and single implementation path

Mac promotion requires one tested implementation path that owns preflight,
accepted-byte staging, complete LaunchAgent validation, natural-cycle-boundary
transition, post-launch identity verification, emergency containment, and
rollback. A future implementation must make every unapproved pre-launch
failure stop before service mutation and must have fixture and CI coverage for
those stops.

This contract must not duplicate that path with copy-paste shell, pseudo-command
blocks, or alternate checkout instructions. Advisory review and exact-head
dry-before-live checks are required gates, but they are not installed-runtime
proof. A checked-out tree, local build, or mutable channel pointer never
supplies the accepted runtime bytes.

The tested promotion and rollback implementation is not yet established for
this contract. Its absence is an active Mac GA release blocker, not an implied
manual step. The later manifest and release-candidate canary successors are
explicit owner-gated dependencies.

## Product, entitlement, and distribution separation

The local agent uses the existing BYO GitHub App boundary for customer-owned
repositories; managed account authorization, billing, activation, and current
launch entitlement remain distinct evidence domains. Issue enrichment is
reported separately from review execution and Desktop health. Codex runtime
state is reported separately from customer outcome.

Distribution and updater evidence must identify the signed artifact, feed
signature, ring, entitlement requirement, and rollback target. `beta` is a
rollback-capable canary ring; `stable` is promoted only after the required
artifact, entitlement, updater, and rollback evidence is accepted. Neither ring
may infer readiness from a branch name or mutable feed state.

## Rollback and containment invariants

Rollback selects a previously accepted immutable signed/notarized packet and
verifies its identity before transition. It does not require the current
checkout, current build, or current runtime health to be trustworthy. A bounded
drain and natural-cycle transition are preferred; if that boundary is unavailable,
the tested implementation must provide an independently reachable emergency
containment and rollback path.

Rollback preserves customer state, database identity, allowlists, and Keychain
secrets. It does not widen permissions, replace BYO credentials, or reset state
as a shortcut. Emergency containment is limited to the exact LaunchAgent path
and label and remains available when checkout, config, or evidence collection
is unhealthy.

## Dependencies and proof boundary

This contract depends on merged PR #831's Desktop-only npm policy, the planned
manifest/RC canary successors, and a separately tested promotion/rollback
implementation. The current beta.87 sealed wrapper/helper shape is a source
reference, not GA evidence. Until those dependencies and the immutable packet
gates are proven, this PR proves only an architecture contract and reviewable
source text. It does not prove signing, notarization, feed publication,
installed runtime, fleet adoption, customer readiness, or Mac GA release
readiness.
