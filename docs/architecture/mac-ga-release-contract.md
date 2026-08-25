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
- Keychain-only provider, license, GitHub user-token, activation, and
  customer-owned GitHub App private-key secrets.
- The existing local review agent and customer-owned (BYO) GitHub App path,
  kept separate from any managed account path.
- Codex runtime integration, issue enrichment, billing, and activation, each
  with independently attributable account evidence.
- Signed distribution, feed metadata, updater behavior, and explicit beta and
  stable rings.

The native Desktop version line is `1.1.0`; the npm CLI remains `1.0.4` unless
its bytes change. For the final Desktop `1.1.0` tag, the npm publication is a
no-op only when the packet contains an unchanged-CLI-byte receipt: a byte-level
comparison of the candidate CLI/package file manifest and tarball digest with
the published `neondiff@1.0.4`. Any changed CLI- or worker-owned byte requires a
new CLI version and publication. The Desktop-only classifier from merged PR
#831 is not that receipt and does not by itself prove a Desktop artifact,
publication, or customer readiness.

## Runtime identities and authorities

The installed Desktop wrapper is
`/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop`. It must launch the
sealed helper
`/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker`; wrapper and helper
identity and digest are separate required facts.

The local worker LaunchAgent identity is the configured, selected `launchdLabel`
for that bot. Every packet, runtime receipt, containment action, and rollback
receipt binds to that selected label; no hard-coded global label is authority.
There are two supported plist states: a new secret-free install has the
complete parsed program, arguments, account/device placeholders, and no
`EnvironmentVariables` or unexpected keys; no new install may introduce
credential environment variables. A supported existing-bot migration may
initially retain only the parser-accepted legacy credential environment (the
App-ID key or legacy alias, private-key-path key or legacy alias, and optional
`NODE_OPTIONS=--use-system-ca`). Its packet records `legacy-environment` mode
and a redacted key-set receipt, never values. Migration must remove that
environment and re-prove the secret-free contract before GA promotion.
Operator account-scoped config, device values, and legacy credential values
remain private and never enter public evidence.

The signed release bundle exposes exactly one authorization contract in its
`Info.plist`; missing, mixed, or `none` markers fail closed: BYO is
`NeonDiffPaidBetaContract=paid-mac-beta-byo-v1` plus
`NeonDiffBYOGitHubEnabled=true`, with no managed marker/origin; managed is
`NeonDiffPaidBetaContract=paid-mac-beta-v1` plus
`NeonDiffManagedGitHubBrokerEnabled=true` and the approved origin
`https://neondiff-license.fly.dev`, with no BYO marker. The packet records the
extracted contract, exclusive marker set, and managed origin. Markers select
composition only; Keychain, GitHub visibility, and current entitlement remain
authoritative.

Every release bundle also records one lowercase 40-hex `NeonDiffSourceSHA`
derived from the exact clean release checkout before signing. The authenticated
tree proof and accepted packet retain that marker and reject it unless it equals
the peeled annotated-tag commit; this is a signed source binding, not standalone
build provenance.

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

- source SHA, immutable tag object, protected/signed-tag verification, and
  provenance binding exact artifact/tree digests to that source/build;
- packet-named ZIP SHA-256 and the exact extraction used for
  `sha256-tree-v1`, including security-relevant regular-file mode bits;
- Team ID, bundle ID, version/build, approved wrapper/helper/framework
  entitlements, hardened-runtime/CodeDirectory flags, timestamp, notarization,
  stapling, and Gatekeeper receipts;
- exact `SUFeedURL`, `SUPublicEDKey` fingerprint, approved channel, appcast
  identity/digest, and verified Sparkle `edSignature` on the download enclosure
  (feed metadata is not an enclosure signature);
- `LSMinimumSystemVersion`, candidate-bound startup and worker receipts on
  every supported macOS target; current-head P0-P2 thread dispositions, the
  successful `Build, test, and package` job, and accepted-head relationship;
- config path, normalized config revision digest, DB identity, and allowlist
  identity, revalidated before mutation and after launch;
- service-attributed current-launch entitlement receipt (account, launch,
  verification time, validity window) and provider/model verification receipt
  bound to the account/config revision and its time window;
- selected label and parsed plist, wrapper/helper identities and digests, and
  the persisted recovery descriptor used for containment;
- clean-Mac download/quarantine/install/startup/worker evidence, compatible
  rollback/re-update evidence, candidate-bound beta outcome receipt, observation
  window/threshold result, last-known-good packet, verified rollback-feed
  publication, and a predecessor update check proving monotonic build order.

The packet is redacted, account-bound, content-addressed, and retained in an
immutable evidence location. Immediately before staging, promotion re-resolves
the tag and packet digest, fetches the packet-named ZIP by SHA-256, extracts
that archive into fresh staging, computes the tree identity, and rejects any
mismatch, unavailable/changed reference, untrusted location, or changed config.
It contains references to secrets rather than secret values.

For Desktop `1.1.0`, the retained location is the immutable evidence-only
GitHub prerelease/tag `neondiff-accepted-packet-v1.1.0`, excluded from latest
selection and targeted at the packet artifact-source commit. It contains
exactly the content-addressed accepted packet and its content-addressed verified
artifact-source-attestation bundle. The 30-day Actions artifact is transit for
first publication only and is never the authority for a later read.

The workflow first runs a read-only resolver against the fixed canonical
repository and evidence tag. It validates the canonical `main` and workflow
identity, reports only `absent` or `present`, and fails closed on partial state.
The canonical producer depends on that resolver and runs only for `absent`; it
cryptographically verifies the exact artifact-source bundle before it emits
either content-addressed name. The retention job has separate contents-write
and attestations-read authority and evaluates after both jobs even when the
producer is skipped. A `present` branch requires resolver success plus a skipped
producer, while an `absent` branch requires resolver success plus producer
success.

On first publication, retention requires the current producer names,
artifact-source SHA, and signer-workflow SHA, creates the fixed release once,
then reloads and verifies the published assets. On a later dispatch it never
uses the mutable live appcast, a current artifact, a current Actions artifact,
or producer outputs. It discovers the prior exact pair from the immutable
release's only two assets, reloads the exact packet-named stable artifact, and
cryptographically verifies the retained bundle against that artifact and the
stored fixed signer workflow/ref/SHA. The signed predicate also carries the
accepted packet SHA-256, which must match the retained content-addressed packet.
It also validates the tag, target commit, names, bytes, digests, sizes, URLs,
and GitHub release/asset attestations. Thus a principal with contents-write
authority cannot substitute self-declared signer claims or pair a genuine
artifact proof with a fabricated packet, and a later `main` SHA cannot replace
or invalidate the accepted historical pair.

A missing release and tag permits first publication; both present permits only
verification. Partial or mismatched state fails closed. No workflow may
overwrite, delete, or rotate retained evidence. Exceptional deletion is a
separately reviewed repository-administrator action and permanently retires the
immutable tag; any approved successor uses a new fixed identity.

## Gates and single implementation path

Mac promotion requires one tested implementation path owning preflight,
accepted-byte staging, complete LaunchAgent validation, natural-cycle-boundary
transition, post-launch identity, emergency containment, and rollback. Every
unapproved pre-launch failure must stop before service mutation and have fixture
and CI coverage. Staging derives bytes only from the packet-named archive and
validates provenance, release contract, updater values, signatures, entitlements,
config revision, entitlement/provider receipts, and exact LaunchAgent mode;
source checkout, local build, mutable feed, or generic workflow cannot supply
accepted runtime bytes.

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

Distribution/updater evidence identifies the signed artifact, enclosure
signature, exact feed/key identity, appcast digest, ring, entitlement, and
rollback target. `beta` is rollback-capable. Before `stable`, the packet must
show at least three independent beta accounts, one successful
startup/update/review session for each on every supported target, a seven-day
window from last install, 100% candidate-bound startup/update success, zero
P0/P1 regressions or state-loss/credential-exposure outcomes, and zero
unresolved P2 threads; unknown denominators or missing outcomes block stable.
These are candidate-bound observations, not fleet/customer authority: they may
not be inferred from process health, ring names, dashboards, or an operator
install, and the authoritative fleet/customer decision remains separate.

Rollback publication or an equivalent updater block must be verified before
restoring an older app so enabled clients cannot select the superseded
candidate; the packet records its exact feed/reference and verification result.

## Rollback and containment invariants

Rollback selects a previously accepted immutable signed/notarized packet and
verifies its identity before transition. It does not require the current
checkout, current build, or current runtime health to be trustworthy. A bounded
drain and natural-cycle transition are preferred; if that boundary is unavailable,
the tested implementation must provide an independently reachable emergency
containment and rollback path.

Rollback preserves customer state, DB identity, allowlists, and Keychain
secrets; clean-Mac rollback/re-update proves compatibility. It does not widen
permissions, replace BYO credentials, or reset state. Emergency containment is
limited to an integrity-checked recovery descriptor persisted in the accepted
packet or installed recovery state, containing the exact plist path, selected
label, owner, and executable identity. The tested path resolves only that
descriptor, never checkout/config/evidence or a guessed global label; missing,
changed, or unauthenticated data fails closed.

## Dependencies and proof boundary

This contract depends on merged PR #831's Desktop-only npm policy, the planned
manifest/RC canary successors, and a separately tested promotion/rollback
implementation. The current beta.87 sealed wrapper/helper shape is a source
reference, not GA evidence. Until those dependencies and the immutable packet
gates are proven, this PR proves only an architecture contract and reviewable
source text. It does not prove signing, notarization, feed publication,
installed runtime, fleet adoption, customer readiness, or Mac GA release
readiness.
