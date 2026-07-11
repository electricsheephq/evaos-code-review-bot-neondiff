# Issue #487 GitHub Onboarding Recovery Plan

## Goal

Close the remaining functional acceptance gap in the released GitHub desktop onboarding flow without expanding into the deferred visual-system lane or signed desktop distribution.

## Source Of Truth

- Issue: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/487
- Milestone: #11 `v1.1 — Real Mac Desktop Launch`
- Base: `origin/main` at `7bed4f0f54675739f1c702e181e0d1352132c1e9`
- Branch: `codex/487-github-onboarding-errors`

## Scope

1. Classify GitHub authorization, rate-limit, App-installation, and organization-policy failures into distinct redacted recovery states.
2. Surface Install/Manage GitHub App guidance with selected-repository and least-privilege copy.
3. Show public-free, private-license-required, and insufficient-read-access cues for discovered repositories.
4. Preserve Keychain-only user tokens, config-patch-only allowlist writes, App-authored reviews, and fail-closed private-repo enforcement.
5. Prove the change through core checks, Swift build/bundle smoke, secret/public-claim scans, and visible unsigned dev-app smoke before PR review.

## Non-goals

- No #508 theme or visual-system work.
- No signing, notarization, Sparkle/appcast publication, release tag, npm publish, or customer-ready claim.
- No GitHub App permission expansion or organization-wide install default.
- No live review posting or production allowlist mutation.

## Stop Conditions

- Any token, private repo name, credential, or transient device code reaches durable logs/evidence.
- The UI treats a stored license key as active entitlement proof.
- The implementation needs a client secret in the desktop app.
- Current-head review or CI finds an unresolved P0-P2 issue.

## Exact Next Action

Commit the green implementation, open the #487 PR, then require exact-current-head CI, review-thread, independent spec/safety, and visible dev-app proof before merge.

## Implementation Proof

- `scripts/run-swift-tests.sh --filter NeonDiffDesktopCoreTests`: passed, including HTTP recovery classification, raw-body non-disclosure, request-generation gating, local device-code expiry, App install URL, and repository access cues.
- `swift run NeonDiffDesktopCoreSmoke`: passed.
- `swift build`: passed for the complete SwiftUI target.
- `./script/build_and_run.sh bundle-check`: passed for the unsigned dev bundle.
- Secret scan, public-claims scan, and `git diff --check`: passed.
- Visible unsigned dev-app smoke: Repos pane rendered Install / Manage App, exact core/optional permission copy, and the Access column. No live repo discovery was run, so private repo names were not captured.
- Independent spec and Swift reviews: all reported P2 findings fixed; final re-reviews found no P0-P2 issues.
