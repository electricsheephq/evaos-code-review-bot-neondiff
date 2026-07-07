# NeonDiff Vision

**NeonDiff is the evidence-backed outcome auditor for AI-written and high-risk
pull requests.**

This document states what NeonDiff is for, the system design that serves that
purpose, the invariants that protect it, and what NeonDiff deliberately does
not do. It exists so contributors, operators, and agents can align with the
product direction without reconstructing it from issue history. The worker
runs locally with a GitHub App scoped to explicit repositories; public
repositories are free by default, while private repository review requires an
active private entitlement.

## The Problem

AI-generated code has made pull-request volume and review fatigue worse, not
better. Most AI reviewers respond by competing on breadth: more walkthrough
prose, more comment types, more lifecycle features. Breadth does not fix the
core failure mode — a reviewer that is wrong often enough gets muted, and a
muted reviewer catches nothing.

The scarce resource in code review is not commentary. It is **trust**: when
this reviewer requests changes, is it right?

## The Bet

NeonDiff competes on trust, not breadth:

> The reviewer that measures its own precision on your repo, and only speaks
> when calibrated evidence says it should.

That claim is only meaningful if the system can back it with data, which is why
the core of NeonDiff is not a prompt — it is a closed measurement loop around
every finding it posts. The core job is not to sound smart about every diff;
it is to make high-risk PRs harder to merge without a visible proof trail.

Where NeonDiff fits first:

- AI-authored PRs that touch runtime, security, release, billing, data, or
  customer paths
- docs or config PRs where public claims can drift ahead of shipped behavior
- agent-produced changes that need a durable checklist before human review
- teams that want BYOK or local-model review without handing every diff to a
  hosted review SaaS

## The Calibration Loop

1. **Findings carry validated confidence.** Every finding is schema-validated
   (severity, category, location on current RIGHT-side diff lines, confidence
   in `[0,1]`). Ranking is confidence-aware within each severity tier, the
   inline-comment cap keeps the highest-confidence findings, and optional
   per-severity confidence floors gate `REQUEST_CHANGES` so a single
   low-confidence high-severity finding cannot block a PR on its own.
2. **Outcomes are observed, not assumed.** A post-merge outcome observer
   revisits reviewed PRs and records what actually happened — revert, hotfix,
   merged fix, human thread — as per-finding outcome labels. Negative controls
   are explicit: a clean run is only credited as clean when it is deliberately
   marked, never inferred from the absence of labels.
3. **Labels become empirical precision.** A batch calibration runner aggregates
   outcome labels into per-confidence-bin precision with Wilson lower bounds —
   the same statistics the offline eval harness uses, computed from live
   history.
4. **Feedback into behavior is human-gated.** The promotion tooling emits a
   reviewable patch file; it never rewrites live config on its own, and the
   public "calibrated" display mode is never machine-written under any flag.
   Public confidence display stays redacted until hard evidence floors are met
   (at minimum 100 labeled findings, 30 P0/P1 labels, 10 explicit negative
   controls, and a 0.95 Wilson lower bound) and a human applies the change.

The loop makes "evidence-backed" a property of the system rather than a
marketing sentence: the same numbers that would justify the calibrated claim
are the numbers that tune ranking, floors, and suppression.

## Design Invariants

These hold for every change, and reviewers should reject changes that break
them:

- **Quieter-only feedback.** Learned signals — confidence floors, category
  precision floors, repo-memory false-positive suppression, self-consistency
  refutation — may demote, suppress, or strip request-changes eligibility.
  They never promote a finding or escalate the review verdict.
- **Fail-closed configuration.** Unknown keys, out-of-range values, and
  malformed shapes are rejected at load, not silently ignored.
- **Entitlement-gated private review.** Private or commercial review requests
  stop before checkout, file listing, provider calls, or GitHub review posting
  when entitlement proof is missing.
- **Additive and default-off.** New gate behavior ships disabled and opt-in,
  with dry-run evidence, before anyone depends on it.
- **Advisory proof boundaries.** NeonDiff does not claim calibrated accuracy
  before evals prove it. Confidence numbers are redacted from public surfaces
  until the calibration gate is legitimately passed.
- **Posting safety.** App-authored identity, at most one review per
  `{repo, pr, head_sha}`, current-head re-checks before every live operation,
  no `APPROVE`, no merges, no repo mutation, and secret-looking findings are
  suppressed rather than posted redacted.
- **Local-first, BYOK.** Diffs go to the providers the operator configured,
  under the operator's keys and budget — not to a hosted review service.

Strong automation should reduce ambiguity for a human maintainer. It should not
hide the boundary between evidence, judgment, and authority.

## Provider And BYOK Boundaries

NeonDiff is local-first, but model egress depends on the provider path the
operator chooses.

- Local or self-hosted endpoints can keep prompts and diffs on the operator's
  machine or network when the model runtime is actually local.
- Hosted providers, including ZCode-backed GLM/Z.ai or hosted
  OpenAI-compatible BYOK gateways, can receive the prompt and diff context
  needed to produce a review.
- Provider keys belong in environment variables, local operator wrappers, or
  supported secret paths. They do not belong in tracked config, GitHub comments,
  release notes, or evidence packets.
- Provider keys are not NeonDiff entitlements. They unlock model access, while
  NeonDiff entitlements govern which repo visibilities the worker may review.
- NeonDiff support tiers are software/support entitlement boundaries. Provider
  and model costs stay external through BYOK or local models.
- Active private entitlement covers private repos and public repos when an
  operator disables the default public-free path. Public-only entitlement does
  not unlock private repos.
- Provider resource catalogs are discovery aids, not proof that a provider can
  run NeonDiff reviews.

See [providers.md](providers.md), [pricing.md](pricing.md), and
[license-boundary.md](license-boundary.md) for the current public beta wording.

## What NeonDiff Deliberately Does Not Do

- **No breadth race.** Walkthrough prose, issue planners, and feature parity
  with hosted reviewers are not goals. A feature earns its place by sharpening
  precision, calibration, or safety — not by matching a competitor's tab.
- **No autonomous repo mutation.** NeonDiff does not approve, merge, push
  fixes, or expand its GitHub permissions by configuration alone.
- **No unearned claims.** No "calibrated" label, accuracy percentage, or
  benchmark claim appears on a public surface before the evidence gate passes.
- **No hosted diff processing.** There is no NeonDiff server reading your
  code. The worker runs where the operator runs it.

## Issue Enrichment Boundary

Issue enrichment is a separate rollout lane from pull request review.

- PR review allowlists do not opt repositories into issue enrichment.
- Issue enrichment needs its own allowlist, repo-level throttles, and live-post
  gate before comments can go out.
- New issue-enrichment rollouts should keep
  `processExistingOpenIssuesOnActivation=false` so enabling the lane does not
  imply scanning or commenting on an existing issue backlog by default.

See [issue-enrichment.md](issue-enrichment.md) for the rollout policy and
[license-boundary.md](license-boundary.md) for the public/private entitlement
matrix.

## Where This Goes

The near-term direction is deepening the loop, not widening the surface:
per-category rolling precision consulted by ranking and the request-changes
gate, relevance-scored related context, and outcome-weighted review routing
once — and only once — a calibrated signal exists to route on.

The proof goes public: per-repo precision badges and a reproducible
local-model review leaderboard turn the calibration loop into NeonDiff's
distribution engine, and a propose-only fixer (`neondiff fix`) closes the
loop from calibrated finding to auditable draft PR — never past the human
merge gate. Both surfaces obey the same evidence discipline as everything
else here: no number renders below the calibration gate, and no fix ships
without a human merge. The public
roadmap is tracked in
[#103](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103);
the ranking/scoring and calibration program that produced this document is
[#278](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/278).

## Related Documents

- [README](../README.md) — product overview, install, safety boundaries
- [calibration-loop.md](calibration-loop.md) — the operator guide for running
  the loop end to end
- [neondiff-config.md](neondiff-config.md) — the configuration surface,
  including the review gate and calibration keys
- [eval-harness.md](eval-harness.md) — offline evaluation and calibration
  statistics
- [release-governance.md](release-governance.md) — versioning and the GA line
- [CHANGELOG](../CHANGELOG.md) — shipped changes by version

## Proof Boundary

This vision document states product intent and contributor alignment. It does
not prove setup, provider quality, release readiness, marketplace readiness,
desktop readiness, legal readiness, or GA readiness. Those claims need their
own validation artifacts and tracked issues before they can move into public
product copy. It also does not prove issue-enrichment rollout readiness for any
repo unless that repo has separate allowlist, threshold, and evidence coverage.
