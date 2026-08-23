# NeonDiff Mac GA architecture and release contract

Status: current architecture for the native Mac GA lane, not release evidence. A candidate records exact source-head and artifact identities in its versioned Desktop
manifest; the CLI publication manifest is separate.

## Separate delivery lanes

CLI/dashboard `neondiff@1.0.4` and native Desktop `1.1.0` share security and review policy, but not release identity or activation:

| Lane | Supported surface | Must not claim |
| --- | --- | --- |
| CLI/dashboard | npm package, local HTML dashboard, API-backed activation, local worker | native Swift maturity, signed distribution, Sparkle, or Desktop GA |
| Native Desktop | signed macOS app, native onboarding, sealed worker, paid BYO (managed later), Sparkle channel | that source, an unsigned bundle, or the CLI manifest is a native release |

`docs/public-release-manifest.json` remains the CLI record. Desktop candidates use a versioned manifest/schema; do not merge or rewrite these records.

## Native production contract

The signed bundle advertises exactly one release-only `Info.plist` contract;
missing or mixed markers quarantine it before useful work:

- Paid BYO: `NeonDiffPaidBetaContract=paid-mac-beta-byo-v1` plus `NeonDiffBYOGitHubEnabled=true`, with no managed marker/origin.
- Managed: `NeonDiffPaidBetaContract=paid-mac-beta-v1` plus `NeonDiffManagedGitHubBrokerEnabled=true`, fixed origin `https://neondiff-license.fly.dev`, and no BYO marker.

Markers select composition; they do not grant access. GitHub visibility, Keychain controls, server entitlement, and fail-closed checks remain authoritative;
BYO and managed activation are mutually exclusive.

## Sealed worker and Codex boundary

The signed app contains one executable worker. Credential-bearing operations route through it and pass secrets once through bounded stdin; keys never enter argv,
environment, config, logs, or evidence. It validates the signed app, plist, config identity, Keychain items, and launchd ownership before starting.

With `codexRuntime`, `config inspect` is the source of truth for exact Codex CLI
path/model/reasoning; the app never stores OAuth material. Disabled Codex uses the selected provider registry and bounded stdin.

## Candidate gates and claim boundary

Keep separate `pending`, `blocked`, and `proven` state for exact source head,
artifact checksum, signing/notarization, feed, site, billing, customer,
runtime, and rollback. CI, source inspection, fixtures, URLs, or a running
process cannot inherit another gate's proof. GA also needs #524 exact-artifact
customer evidence, #116 updater/rollback, #449 distribution, and current
billing/provider/site/review/runtime evidence. This docs PR is `pr_ready` only;
it does not establish release, runtime, customer, signed-artifact, or GA readiness.

## No-downtime and rollback

Stage/hash the candidate; validate source, contract, signature, and manifest;
take a read-only snapshot; switch only the same named worker slot; then re-read
status while retaining last-known-good. A failed preflight, ambiguous owner,
missing prior candidate, or failed post-switch status stops before replacement.
Never delete a candidate tree, alter customer config/Keychain/DB, widen an App
allowlist, or restart an unrelated worker. A source/docs PR never authorizes
launchd promotion.

## Operator paths and preflight contract

Runbooks use `/Users/m1/repos` for clean checkouts and `/Users/m1/Codex` for
evidence. They validate absolute paths, NeonDiff identity, clean exact-head,
runtime config, evidence root, and LaunchAgent plist before navigation, sync,
test, build, tag, promotion, or `launchctl`. The preflight exits on failure;
returning from a helper is insufficient. Historical packets must not be copied
into new commands.
