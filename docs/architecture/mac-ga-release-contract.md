# NeonDiff Mac GA architecture and release contract
Status: current native Mac GA architecture, not release evidence; this docs successor is `pr_ready` and proves no release, runtime, customer, signing, or GA readiness.
## Delivery lanes and identity
CLI/dashboard `neondiff@1.0.4` owns npm, dashboard, API activation, and local worker;
it must not claim signed Desktop/Sparkle maturity. Native Desktop `1.1.0` owns signed
onboarding, sealed worker, paid BYO (managed later), and Sparkle; GA uses shared
repository tag/release `v1.1.0`, not npm, and npm stays `1.0.4` unless CLI bytes
change. Pre-GA fixtures may use `v1.1.0-beta.N`, never a second tag.
## Sealed worker, activation, and proof boundary

The signed app has one sealed worker; credential operations pass secrets once through bounded
stdin and keys never enter argv, environment, config, logs, or evidence. Paid BYO and managed
markers are mutually exclusive; Keychain, GitHub visibility, server entitlement, and signed-app
checks remain authoritative. `codexRuntime` uses `config inspect` for exact CLI path/model/reasoning
and never stores OAuth material. Keep `pending`, `blocked`, and `proven` state separate for
source, bytes, signing, feed, site, billing, customer, runtime, and rollback.

## No-downtime and operator contract

Stage/hash, validate source/contract/signature/manifest, take a read-only snapshot, switch only
the same named worker slot, retain last-known-good, and re-read status. Failed preflight,
rollback target, pre-launch validation, or post-switch status stops replacement; never alter
customer config/Keychain/DB, widen an App allowlist, or restart another worker. Runbooks use
`/Users/m1/repos` and `/Users/m1/Codex`; two-phase preflight validates account config, exact
sealed-worker `Program`/`ProgramArguments`, plist label, clean `main`, and approved head.
Rollback source/tag/reset/build/status failures stop before `launchctl`; post-launch status is a
verification/rollback trigger.
