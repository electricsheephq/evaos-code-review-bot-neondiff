# NeonDiff Mac GA release contract

Status: current architecture contract for the native Mac GA hardening lane.
This document is a source-and-release contract, not release evidence. It is
anchored to the exact source head being prepared by this change:
`de00a1daf20c27b1d14fff5a5defb9b5597e71b5`.

## Product lanes and version boundary

NeonDiff has two versioned delivery lanes. They share review policy and public
security rules, but they do not share release identity or activation semantics.

| Lane | Version contract | Supported surface | Must not claim |
| --- | --- | --- | --- |
| CLI / dashboard | `neondiff@1.0.4` | npm package, local HTML dashboard, API-backed activation for every repository, local worker/daemon | native Swift maturity, signed Mac distribution, Sparkle, or v1.1 readiness |
| Native Desktop | `1.1.0` candidate line (beta before GA) | signed macOS app, sealed worker, native onboarding, BYO or later managed contract, Sparkle channel | that a source build, unsigned app, or CLI manifest is a native release |

`docs/public-release-manifest.json` remains the CLI/dashboard `v1.0.4`
publication record. A Desktop candidate uses the separate, versioned
[`v1.1.0-desktop-candidate-manifest.json`](../release-candidates/v1.1.0-desktop-candidate-manifest.json)
validated by [`desktop-candidate-manifest.schema.json`](../schema/desktop-candidate-manifest.schema.json).
Do not merge the two manifests or rewrite the published CLI record to describe
Desktop artifacts.

## Production contracts

The native release bundle must advertise exactly one contract in `Info.plist`.
Missing, mixed, or debug-only values leave production composition quarantined.

| Contract | Required public markers | Credential / entitlement boundary | Status |
| --- | --- | --- | --- |
| Paid BYO (`paid-mac-beta-byo-v1`) | `NeonDiffPaidBetaContract=paid-mac-beta-byo-v1`, `NeonDiffBYOGitHubEnabled=true`; no managed marker or origin | customer-owned GitHub App; paid activation for the supported repository; no official-App implication | current native beta path |
| Managed (`paid-mac-beta-v1`) | `NeonDiffPaidBetaContract=paid-mac-beta-v1`, `NeonDiffManagedGitHubBrokerEnabled=true`, fixed broker origin `https://neondiff-license.fly.dev`; no BYO marker | broker-hosted official-App path; exact installation/repository binding; server kill switch and entitlement authority | later convenience path; not required to close the BYO beta |

The marker is a release boundary, not an authorization decision. The server,
GitHub-authoritative repository visibility, Keychain controls, and fail-closed
entitlement checks remain authoritative. A local preference, cached entitlement,
running worker, or App ID alone cannot unlock useful work.

## Candidate identity and required gates

Every Desktop candidate is represented by the versioned manifest. Each gate
records `state`, immutable identity, and public-safe evidence references:

1. **Source:** repository, exact 40-character commit, release ref, clean
   checkout, and (when CI-built) workflow run/artifact identity.
2. **Artifact:** app bundle/archive name, bundle ID, build number, SHA-256,
   and the exact artifact downloaded or tested. A source rebuild is not a
   substitute for exact-artifact proof.
3. **Signing:** Developer ID identity class, nested-code verification, hardened
   runtime, timestamp, and public-safe `codesign` evidence.
4. **Notary:** Apple acceptance reference, stapling validation, and post-staple
   `codesign`/Gatekeeper evidence on the same bytes.
5. **Feed:** Sparkle 2 channel, baked feed URL, public key reference, artifact
   URL/checksum/signature, and a rollback feed or release reference. A fixture
   or local XML dry run is not hosted-feed proof.
6. **Site:** canonical product/download/release-notes URLs and the same
   immutable artifact checksum. Website publication is separate from app build.
7. **Billing:** paid-BYO or managed entitlement policy, production authority
   reference, and activation/recovery evidence. Billing status is never
   inferred from a package or website link.
8. **Customer:** exact-artifact install, onboarding, provider, dry-run/live
   review, entitlement-loss/recovery, support, and update/rollback canary
   references. Desktop-eval evidence from #524 is required for GA; CI alone is
   not customer evidence.
9. **Runtime:** named launchd label, worker version, config identity, current
   daemon evidence, and an explicit no-downtime receipt. Runtime adoption is a
   separate gate from source and release publication.
10. **Rollback:** last-known-good version, exact artifact checksum, feed/release
    reference, state-preservation requirement, and operator trigger.

No gate may inherit a pass from another gate. A candidate remains `pending` or
`blocked` when any required identity or evidence is absent.

## No-downtime and rollback invariant

Maintenance must preserve the existing customer worker until the replacement
has been verified. The supported sequence is: stage and hash the candidate;
validate source, contract, signature, and manifest; take a read-only status
snapshot; switch only the same named worker slot; then re-read status and retain
the prior candidate for rollback. A failed preflight, ambiguous ownership,
missing prior candidate, or failed post-switch status stops before replacement.

The sequence must not delete or overwrite a pre-existing candidate tree, alter
customer config/Keychain/DB, widen an App allowlist, or restart an unrelated
worker. A documentation or source PR never authorizes launchd promotion. The
runtime issue #738 remains its own maintenance lane; its health evidence cannot
be substituted for exact Desktop release evidence.

## GA decision boundary

The paid BYO beta outcome in #610 is complete, but Mac GA remains open under
roadmap #103 and milestone #11. GA requires, at minimum, current-head CI and
review, #116 signed updater/feed and rollback proof, #524 exact-artifact desktop
evaluation/customer canaries, residual #449 distribution proof, production
billing/GitHub/provider evidence, and immutable site/release alignment.

Issue #806 is the current packaging/restoration slice for the exact base. Its
source and focused tests may prove the BYO marker and restoration contract; they
do not by themselves prove signed distribution, installed runtime safety,
customer readiness, or GA.

## Active path and evidence rules

Runbooks must use operator-provided paths, never a historical machine mount:

```sh
export NEONDIFF_RELEASE_CHECKOUT="${NEONDIFF_RELEASE_CHECKOUT:?absolute clean release checkout}"
export NEONDIFF_RUNTIME_CONFIG="${NEONDIFF_RUNTIME_CONFIG:?absolute active config path}"
export NEONDIFF_EVIDENCE_ROOT="${NEONDIFF_EVIDENCE_ROOT:-$HOME/Codex/evidence/neondiff}"
export NEONDIFF_LAUNCH_AGENT_PATH="${NEONDIFF_LAUNCH_AGENT_PATH:?absolute LaunchAgent plist path}"
```

Before navigation, sync, testing, build, tagging, promotion, or `launchctl`,
the runbook preflight must reject any non-absolute path, missing checkout,
non-NeonDiff `origin`, dirty checkout, missing runtime config, missing evidence
root, or missing LaunchAgent plist. The preflight is an executable operator
boundary; this architecture contract does not treat a path string alone as
proof of repository, config, or runtime identity.

Historical release packets may retain the paths recorded at the time they were
written. Current runbooks must not copy those paths into new commands or claim
that a missing mount is live evidence.

## Claim boundary and prohibited shortcuts

This contract may establish architecture, required identities, and a
public-safe candidate packet (`pr_ready` when its PR checks pass). It does not
establish release readiness, signed/notarized distribution, hosted updater
identity, runtime safety, customer readiness, or GA. Never use a green CI run,
fixture, source-only Info.plist inspection, website URL, or running process as a
shortcut for those gates.

Related source of truth: roadmap #103, execution tracker #610, GA milestone
#11, updater #116, Desktop evaluation #524, packaging/restoration #806, and
runtime maintenance #738. GitHub issues/PRs and release artifacts own durable
state; this document is the repo architecture contract.
