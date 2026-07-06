# NeonDiff Vision

**NeonDiff is the evidence-backed outcome auditor for AI-written and high-risk
pull requests.**

This document states what NeonDiff is for, the system design that serves that
purpose, the invariants that protect it, and what NeonDiff deliberately does
not do. It exists so contributors, operators, and agents can align with the
product direction without reconstructing it from issue history.

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
every finding it posts.

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

## Where This Goes

The near-term direction is deepening the loop, not widening the surface:
per-category rolling precision consulted by ranking and the request-changes
gate, relevance-scored related context, and outcome-weighted review routing
once — and only once — a calibrated signal exists to route on. The public
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
