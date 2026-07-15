# NeonDiff Agent Instructions

## Repository Agent Quick Start

If you are a coding agent working in this repository:

1. Read README.md for the public product promise and proof boundary.
2. Read CONTRIBUTING.md for issue routing, validation, evidence, and PR
   expectations.
3. Read docs/SETUP.md before changing install, GitHub App, provider, daemon, or
   first-run behavior.
4. Read SECURITY.md before touching vulnerability reporting, secrets, auth,
   posting policy, or private-data handling.
5. Create or reuse a GitHub issue before meaningful implementation work.
6. Write or update a failing test, smoke, or eval scenario before the minimal
   implementation.
7. Do not commit GitHub App private keys, provider tokens, license keys,
   customer data, private logs, local SQLite DBs, cookies, connector URLs, or
   credentials.
8. Do not restart launchd, promote a live beta, expand GitHub App permissions,
   flip repo visibility, publish packages, or create GitHub Releases unless the
   issue explicitly scopes that action.
9. For setup or GitHub App setup changes, update README.md,
   docs/SETUP.md, docs/github-app-setup.md, and the website onboarding copy in
   the current website repo before claiming the first-run path is fixed.
10. Update the issue before handoff, merge, pause, or external-review wait.

## Source-Available Product Boundary

- NeonDiff is source-available beta software.
- Public open-source repositories are free and require no NeonDiff Activation Key
  (owner ruling; the #532 "activate every repository" pivot is reversed).
- API-backed activation is required for supported private, internal, and
  commercial repository work; unknown visibility fails closed. GitHub-authoritative
  visibility decides the tier, and provider verification is still required for all
  tiers. Enforced at the #614 authorization boundary; public-facing website copy
  migration is owned by website #52.
- Active individual, organization, trial, or legacy entitlements govern supported use and update access.
- License keys support paid/private usage and update entitlement.
- Exact license text, public/private grants, and commercial terms are governed
  by https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104. Public beta
  release readiness is tracked by https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/232.

Do not claim open-source/MIT status, public launch completion, GA readiness,
CodeRabbit parity, enterprise readiness, or legal adequacy from this file.

## Shared Owned-Repo Policy

- GitHub issues and PRs are implementation truth.
- The NeonDiff public product roadmap is #103.
- Public CLI/package setup is #107 and release-readiness packaging is #232.
- Agent-first docs are #113.
- Website changes currently live in `electricsheephq/neon-diff-agent-website`,
  not this repo. Verify the active website repo before editing because older
  marketing clones may still exist locally.
- Before merge, release, or readiness claims, query current-head review threads
  and separate resolvable review threads from top-level bot comments and check
  annotations.
- P0-P2 current actionable review threads block merge/release unless fixed,
  proven false-positive, or explicitly escalated.

## Validation Rules

- Prefer a focused failing test first, then the minimal implementation.
- Coding agents default to the narrowest relevant local test or smoke, followed
  by `git diff --check`.
- `npm test` and `npm run build` are broad GitHub CI checks by default.
- The existing required GitHub Actions `Build, test, and package` job is the
  authoritative full test, build, package, and safety gate; focused local checks
  are not a substitute.
- Run broad local validation only for CI reproduction, a missing focused
  harness, or an explicit user request.
- For review-behavior changes, include dry-run evidence and current-head proof.
- Keep evidence public-safe: summaries, counts, refs, hashes, setup states, and
  command names are fine; raw secrets, raw private diffs, private logs, keys,
  tokens, and customer data are not.

## Public Documentation Placement

- Keep README.md as the public landing page: product value, install, setup,
  first dry-run review, safety boundaries, and links.
- Keep first-run detail in docs/SETUP.md.
- Keep operator commands in docs/operator-cli.md.
- Keep live beta promotion in docs/beta-release-runbook.md and
  docs/release-governance.md.
- Keep issue routing and contribution rules in CONTRIBUTING.md.
- Keep agent-specific repository behavior in this AGENTS.md.

Do not put long release ledgers, local-only raw command dumps, internal live
paths without context, or active sprint churn into the README.
