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

The native Desktop version line is `1.1.0`; the accepted CLI/package boundary
for this release is immutable registry `neondiff@1.0.5`. For the final Desktop
`1.1.0` tag, the package gate is satisfied only after changed CLI- or
worker-owned bytes are proved against the exact reviewed `neondiff@1.0.5`
candidate and its immutable registry artifact. The immutable `neondiff@1.0.4`
package remains the predecessor and rollback boundary. The Desktop-only
classifier from merged PR #831 is not that receipt and does not by itself
prove a Desktop artifact, publication, or customer readiness.

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

## Construction, verification, and promotion order

The release stages are ordered; later evidence cannot be a prerequisite for
creating the artifact that produces it. Under #610's product-first staging
admission, #559 may establish exact immutable `neondiff@1.0.5` package,
provenance, worker-byte, and install evidence while redundant same-version
`release-candidate` alias cleanup remains open. This permits private staging
only. It does not satisfy the strict typed publication validator, close #559,
or permit public GA; never report an absent alias while it is present.

1. Prove the supported development/staging setup and dry-review path before
   Developer ID signing or notarization. Do not use the operations installation
   to debug a candidate.
2. Construct from the accepted clean source, append-only declaration, exact
   package identity, and approved credential profile. A final artifact digest,
   notarization result, or accepted promotion packet does not exist yet.
3. After signing, notarization, stapling, and packaging, verify the actual
   artifact and collect its immutable identity and clean-host evidence.
4. Assemble and accept the promotion packet only from real completed evidence
   for the selected gate. Source acceptance of #895 precedes RC publication;
   its live transition acceptance and the stable minimums precede stable
   promotion. Construction receipts cannot substitute for these approvals.

The immutable GitHub release used as the packet producer's artifact input is
not itself accepted promotion. Its separately authorized, reported creation
may follow private signed-byte testing and #895 source acceptance while
feed/site/download promotion remains held. #1093 must reconcile the producer's
feed prerequisites and protected stable-declaration selection before execution;
do not synthesize stable identity from an uploaded asset or imply GA acceptance.

This ordering adds no alternate transition implementation or evidence schema.
The accepted-packet validation, cryptographic binding, two-asset retention,
append-only history, and no-replacement rules below remain mandatory. An
incomplete construction record must never be passed off as an accepted packet.

## Immutable accepted evidence packet

Every accepted promotion decision names one immutable packet containing the
completed evidence required by its release gate:

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

For every accepted Desktop `1.1.0` beta, RC, or stable release, the retained
location is an immutable evidence-only GitHub prerelease/tag named
`neondiff-accepted-packet-<release-tag>`, excluded from latest selection and
targeted at the packet artifact-source commit. Each location contains exactly
the content-addressed accepted packet and its content-addressed verified
artifact-source-attestation bundle. The canonical stable location remains
`neondiff-accepted-packet-v1.1.0`. The 30-day Actions artifact is transit for
first publication only and is never the authority for a later read.

The fixed product release tag, not caller-supplied metadata, determines source
identity. RC and stable require a distinct annotated tag object. An immutable
beta release may instead use a lightweight tag that points directly to the
exact source commit; in that case the packet's tag-object SHA equals its source
SHA by construction. No other channel may use that equality, and every channel
still revalidates the fixed tag ref, source, immutable release, artifact, and
feed. The product release's `target_commitish` is creation metadata rather than
source authority; the fetched tag ref and its peeled commit are authoritative.
An RC's product channel remains `rc`, while its exact retained appcast enclosure
and enclosure-proof channel remain the observed `beta` feed ring.

The workflow first runs a read-only resolver against the fixed canonical
repository and evidence tag. It validates the canonical `main` and workflow
identity, reports only `absent` or `present`, and fails closed on partial state.
Before resolving prerelease evidence it also requires the exact selector in the
protected append-only declaration history at the current `main` SHA.
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
release's only two assets, reloads the exact packet-named product artifact, and
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

Protected transition authority is retained only below
`docs/releases/desktop/accepted-targets`. The empty repository convention is
one zero-byte `.gitkeep`; the first append removes it. Packet filenames bind to
the SHA-256 of exact canonical packet bytes, and target-receipt filenames bind
to the SHA-256 of exact canonical receipt bytes. Every receipt resolves its
target, current, and optional previous packet inside that fixed directory, and
all shared release, source, tag-object, artifact, and tree identities must equal
the parsed referenced packets. Invalid UTF-8, duplicate or extra keys, lossy
numeric build tokens, missing references, symlinks, oversized inputs, or a
content-address mismatch fail closed. Pull-request and protected-main transition
validation preserves every prior packet and receipt byte exactly; the
verifier-backed producer and action derivation remain a separate accepted gate.

That producer runs only in the fixed GitHub-hosted repository, workflow,
`refs/heads/main`, and exact protected-main workspace/SHA context. It invokes
the retained-evidence verifier for the selected target and treats current and
optional previous packet paths only as selectors for exact content-addressed
blobs already present in the protected target-history tree. Selected declaration
position and build derive direction; `currentPath` identifies the newest
declaration but is not a requirement that every installed current or selected
intermediate target still be newest. A first forward update requires a later,
higher-build target not yet retained in target history and no previous selector.
A re-update requires that same later/higher target to be an exact retained blob
and the previous selector to equal it. A rollback requires an earlier,
lower-build target and that exact previous selector. Omitting the selector for
a retained target, relabeling any derived action, or selecting identical or
mutable history fails closed.

Receipts form a reusable append-only set of transition authorities, not a
chronological log of one installation. Installed current/prior state and actual
event ordering are independently authenticated by the later preflight/runtime
gate. The producer emits only one canonical content-addressed public-safe
receipt through exclusive create; it does not install, update, restart, publish,
or mutate protected history.

The dry transition preflight treats that protected receipt and caller action as
selectors only. It reloads the exact protected receipt, target/current packets,
declaration order, retained evidence, artifact tree, appcast, and enclosure
proof under the same fixed protected-main workflow identity, then independently
derives update, rollback, or re-update. It emits only a redacted fixed-step plan
and performs no entitlement, quiescence, staging, swap, restart, feed, runtime,
or customer mutation.

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

The BYO Mac LaunchAgent's background PR review lane remains held. Its heartbeat
proves service liveness only; issue-enrichment success requires lane-specific
result evidence. The independently admitted issue-enrichment lane may run, but
neither its admission nor the heartbeat authorizes a PR review or post. Native
live PR posting uses only the exact scoped `review-pr` dry review plus explicit
same-head confirmation; the matching approval is consumed atomically, and
install/start/restart cannot create it.

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

Issue-enrichment policy aliases resolve through one deterministic casefolded
view, while the casefolded repository key is the durable identity for records,
watermarks, and sticky-comment markers. Existing mixed-case records and issue
markers remain readable without rewriting the database. Adding or reordering a
case alias therefore cannot create another state identity or another sticky
comment for the same repository and issue.

Distribution/updater evidence identifies the signed artifact, enclosure
signature, exact feed/key identity, appcast digest, ring, entitlement, and
rollback target. `beta` is rollback-capable. Before `stable`, the packet must
show at least three independent beta accounts, one successful
startup/update/review session for each on every supported target, a seven-day
window from last install, 100% candidate-bound startup/update success, zero
P0/P1 regressions or state-loss/credential-exposure outcomes, and zero
unresolved P2 threads; unknown denominators or missing outcomes block stable.
The 24-hour and 72-hour/100-cycle acceptance checkpoints may be collected inside
the same seven-day window when their candidate, install, account, target, and
scenario bindings agree; these are not additional consecutive waits. Reinstall
or an identity/behavior change invalidates the affected observations, not
unrelated evidence. Five internal unassisted evaluators remain required by
#524; synthetic sessions cannot substitute.

For #610's observation gate, one cycle is one completed outer worker loop,
not an item, transport retry, or synthetic test iteration. Record 24-hour and
72-hour checkpoints with at least 100 completed cycles by the latter: one
worker pair, no expired held leases or new unclassified failures, a new-failure
rate below 1% (failed cycles / completed cycles), and zero P0/P1, leaks,
stale/duplicate posts or state loss. The redacted #524/#610 receipt binds source,
package/artifact, host/account aliases, install/start/end times, cycle and
failure counts, classification references, and heartbeat/lease summaries;
missing counts or bindings fail the gate. Five internal participants require
at least four unassisted successes and median first review under ten minutes.

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
