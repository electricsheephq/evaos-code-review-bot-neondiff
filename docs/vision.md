# NeonDiff Vision

NeonDiff's wedge is a local-first, evidence-backed outcome auditor for
AI-written and high-risk pull requests.

The product starts from a simple belief: review automation should make the PR
outcome easier to trust, not just add another confident comment. NeonDiff runs
from a local worker, uses a GitHub App with explicit repository scope, records
redacted evidence for each review decision, and keeps provider choice under the
operator's control. Public repositories are free by default; private repository
review requires an active private entitlement.

This document is directional alignment for contributors and agents. It does not
claim GA readiness, hosted-service readiness, or parity with any hosted review
product.

## Wedge

NeonDiff is built for teams and agents that already have AI-generated code in
the review loop and need a second opinion that is:

- current-head only
- repo-policy aware
- evidence backed
- local-first for checkout state, config, credentials, and operator control
- conservative about public confidence, secret handling, and mutation

The core job is not to sound smart about every diff. The core job is to make
high-risk PRs harder to merge without a visible proof trail.

Useful early targets:

- AI-authored PRs that touch runtime, security, release, billing, data, or
  customer paths
- docs or config PRs where public claims can drift ahead of shipped behavior
- agent-produced changes that need a durable checklist before human review
- teams that want BYOK or local-model review without handing every diff to a
  hosted review SaaS

## Calibration Loop

NeonDiff treats review quality as something to measure, not something to imply.
The intended loop is:

1. Run reviews in dry-run or bounded live mode.
2. Store redacted evidence for findings, dropped findings, validation choices,
   provider/runtime metadata, and current-head state.
3. Compare the bot output with later outcomes such as human review, CI, seeded
   defects, negative controls, and post-merge incidents.
4. Feed those labels into scorecards and calibration reports.
5. Promote public confidence displays, request-changes thresholds, or stronger
   routing only when the calibration policy says the evidence is good enough.

Until that loop proves a claim, public comments stay conservative. Raw model
confidence remains internal metadata, and public percentages stay hidden behind
the calibration gate described in
[docs/evals/confidence-calibration.md](evals/confidence-calibration.md).

## Safety Posture

NeonDiff should fail closed before it creates surprise work for maintainers.
The default posture is:

- review only configured repositories
- fail private or commercial review requests before checkout, file listing,
  provider calls, or GitHub review posting when entitlement proof is missing
- re-check pull request head state before planning, finding placement, and live
  posting
- post at most one review for a given `{repo, pr, head_sha}` decision surface
- suppress secret-looking findings instead of posting redacted secrets
- keep findings on current RIGHT-side diff lines
- use dry-run evidence before live posting
- never approve PRs
- never merge branches
- never push repairs
- never expand GitHub permissions just because a repo profile requests it
- never present confidence as calibrated until the eval gate passes

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

See [docs/providers.md](providers.md), [docs/pricing.md](pricing.md), and
[docs/license-boundary.md](license-boundary.md) for the current public beta
wording.

## Deliberate Non-Goals

NeonDiff is not trying to be all of these at once:

- a hosted review SaaS
- an auto-merge bot
- an autonomous branch-repair agent
- a replacement for human code ownership
- a general GitHub issue mutation engine
- a blanket security certification
- a public-confidence product without calibration evidence
- a universal provider marketplace
- a GA release declaration
- a promise that every local setup, provider, or repository shape has already
  been proven

Those may produce useful future work, but each needs its own issue, proof
boundary, and release gate. The near-term shape is narrower: local worker,
explicit repo scope, current-head review, redacted evidence, BYOK/local provider
choice, and conservative outcome auditing for risky PRs.

## Issue Enrichment Boundary

Issue enrichment is a separate rollout lane from pull request review.

- PR review allowlists do not opt repositories into issue enrichment.
- Issue enrichment needs its own allowlist, repo-level throttles, and live-post
  gate before comments can go out.
- New issue-enrichment rollouts should keep
  `processExistingOpenIssuesOnActivation=false` so enabling the lane does not
  imply scanning or commenting on an existing 50+ issue backlog by default.

See [docs/issue-enrichment.md](issue-enrichment.md) for the rollout policy and
[docs/license-boundary.md](license-boundary.md) for the public/private
entitlement matrix.

## Proof Boundary

This vision document states product intent and contributor alignment. It does
not prove setup, provider quality, release readiness, marketplace readiness,
desktop readiness, legal readiness, or GA readiness. Those claims need their
own validation artifacts and tracked issues before they can move into public
product copy. It also does not prove issue-enrichment rollout readiness for any
repo unless that repo has separate allowlist, threshold, and evidence coverage.
