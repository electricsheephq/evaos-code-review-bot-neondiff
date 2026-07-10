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

Commit Slice A, open its PR, and shepherd current-head CI plus bot/human review. Keep #488 open for Slice B provider verification after Slice A merges.

## Slice A Proof

- 24 focused config CLI tests cover bounded paths, revision-bound preview/apply, stable/structured inspect reads, content-sensitive revisions, truthful post-commit results and cleanup warnings, symlink-alias lock convergence, same-process and child-process writer rejection, and live/dead/empty/invalid-owner fail-closed lock behavior with manual recovery.
- Native core checks require typed dry-run/write semantics, lowercase SHA-256 revision proof, and exact operation binding before Preview, Apply, or rollback authorization is accepted.
- TypeScript build, Swift core checks/smoke, Swift build, unsigned bundle check, actionlint, secret scan, public-claims scan, and `git diff --check` pass.
- Two independent read-only reviews are clean after resolving mutable-snapshot, config-path, inspect-ordering, rollback-file, external-drift, and stale-lock liveness findings.
- Visible unsigned dev-app proof:
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/config-control-center.png`
  - `/Volumes/LEXAR/Codex/evidence/neondiff-v1.1/2026-07-10/issue-488/config-control-center-validation.png`
