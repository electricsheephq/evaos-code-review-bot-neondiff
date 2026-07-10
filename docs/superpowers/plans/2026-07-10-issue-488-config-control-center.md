# Issue #488 Desktop Configuration Control Center Plan

## Goal

Expose supported NeonDiff configuration in the native desktop app without raw JSON editing, while keeping secrets in Keychain and every config write validated, preview-first, and reversible.

## Source Of Truth

- Issue: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/488
- Milestone: #11 `v1.1 — Real Mac Desktop Launch`
- Base: `origin/main` at `04694f0a94b265db4b0f65a9c1105497f0c422bc`
- Branch: `codex/488-config-control-center`

## Slice A: Safe Config And Rollback Foundation

1. Expand the desktop-safe config patch allowlist only for bounded review, daemon, and issue-enrichment settings.
2. Parse those settings from the redacted `config inspect` result into a native desktop model.
3. Add separate PR-review and issue-enrichment controls; never reuse `pilotRepos` as the issue allowlist.
4. Generate desired and rollback patches from typed, non-secret settings.
5. Require a successful dry-run preview before Apply; expose Apply Last Rollback after a successful write.
6. Keep invalid values fail-closed in both native validation and the canonical TypeScript config validator.

## Slice B: Provider Verification And Full UI Proof

1. Add an explicit Verify API Key action that reads the provider key from Keychain, returns redacted pass/fail metadata, and never writes the raw key to config, logs, or evidence.
2. Prove Providers, Repos, Policy, License, Logs, and Settings through visible unsigned dev-app smoke.
3. Close #488 only after both slices merge with current-head CI/review proof.

## Non-goals

- No provider adapter changes from PR #471.
- No live daemon config mutation, review posting, issue comment posting, or production allowlist change during smoke.
- No #508 visual-system work.
- No signing, notarization, appcast publication, or v1.1 release claim.

## Stop Conditions

- A provider key, GitHub token, license key, private repo name, or raw config secret reaches logs/evidence.
- PR review and issue-enrichment allowlists are coupled.
- Apply can run without a successful preview or without a rollback patch.
- The desktop validator accepts a setting that the canonical config loader rejects.

## Exact Next Action

Prepare the Slice B PR from the isolated provider-verification worktree, then shepherd current-head CI plus bot/human review. Close #488 only after Slice B merges and both slices remain proven on `origin/main`.

## Slice A Proof

- 25 focused config CLI tests cover bounded paths, revision-bound preview/apply, stable/structured inspect reads including transient torn JSON, content-sensitive revisions, truthful post-commit results and cleanup warnings, symlink-alias lock convergence, same-process and child-process writer rejection, and live/dead/empty/invalid-owner fail-closed lock behavior with manual recovery.
- Native core checks require typed dry-run/write semantics, lowercase SHA-256 revision proof, and exact operation binding before Preview, Apply, or rollback authorization is accepted.
- TypeScript build, Swift core checks/smoke, Swift build, unsigned bundle check, actionlint, secret scan, public-claims scan, and `git diff --check` pass.
- Two independent read-only reviews are clean after resolving mutable-snapshot, config-path, inspect-ordering, rollback-file, external-drift, and stale-lock liveness findings.
- Visible unsigned dev-app proof:
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/config-control-center.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/config-control-center-validation.png`

## Slice B Contract And Proof

- The explicit native **Verify API Key** action reads the stored provider key from Keychain only for that operation and delivers it to `neondiff providers verify` exclusively over bounded standard input. Raw key material never enters argv, process environment, config, command previews, stdout/stderr, logs, screenshots, or evidence.
- A hosted provider smoke requires the user's explicit Verify click and `--allow-remote-smoke true`; no hosted verification runs automatically. The CLI reuses the existing hardened `verifyProviderApiKey` transport.
- Only an exact redacted `healthy` envelope with a successful process exit is verified. `configured_unverified` is metadata-only non-success, `blocked` is non-success, and malformed or contradictory results clear any earlier verified state.
- Unsigned visual evidence uses a debug-only redacted fixture that bypasses Keychain reads and makes no provider request. It proves the Providers-pane action/result rendering and the presence of the Slice A configuration sections, not live-provider health or packaged-app behavior.
- Visible proof packet:
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/provider-verification-full-pane.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/provider-verification-result.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/configuration-repos-pane.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/configuration-policy-pane.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/configuration-license-pane.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/configuration-logs-pane.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/configuration-settings-pane.png`
  - SHA-256 manifest: `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/SHA256SUMS.txt`
- The current `run-model-checks.sh` compile harness is temporary proof because this workstation lacks full Xcode. Follow-up must install full Xcode, extract `NeonDiffDesktopModel` into an importable `NeonDiffDesktopAppCore` library target, make the app depend on that target, and add a Swift Testing/XCTest target. This Slice B branch intentionally does not perform that architecture refactor or Xcode installation.
- Slice B does not prove signed/notarized distribution, Sparkle/appcast delivery, browser/native parity, customer readiness, or v1.1 release completion.
