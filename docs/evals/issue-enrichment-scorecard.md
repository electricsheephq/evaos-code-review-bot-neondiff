# Issue-Enrichment Scorecard

This scorecard is a standalone advisory fixture contract for issue enrichment. It is not wired into the CLI or worker yet, and it does not make a public parity, calibrated-confidence, runtime-safety, or release-readiness claim.

## Dimensions

Each dimension is scored from `0` to `5`. The evaluator returns both:

- `rawScore`: unweighted average across the ten dimensions.
- `weightedScore`: dimension-weighted average using the executable weights in `src/issue-enrichment-scorecard.ts`.

Scores above `3` require at least one direct evidence link on that case/dimension cell. The validator rejects high scores without direct `http` or `https` evidence links. In this v0.1 contract, validation proves evidence-link presence only; fixture authors must still review whether each link is relevant to the specific coverage scenario.

The current weights are intentionally differentiated so `weightedScore` is not a duplicate of `rawScore`. Proof boundary, throttling, acceptance criteria, related-context precision, and safety carry higher weight because a failure in those dimensions can create misleading readiness or noisy live-posting signals.

The current dimensions are:

- related-context precision
- planning value
- acceptance criteria
- ownership/routing
- proof boundary
- lifecycle state
- noise control
- idempotency
- safety
- throttling

## Metric Contracts

Each dimension owns an executable metric contract with:

- `denominator`: what population the score applies to.
- `dataSource`: the evidence source used for scoring.
- `scoringRule`: how to interpret the `0` to `5` score.
- `unmeasurableState`: when the dimension should be reported as unmeasurable instead of silently scored as zero.
- `pilotThreshold`: advisory and promotion minimums for pilot interpretation.

## Fixture Coverage

The sampled regression packet at `tests/fixtures/issue-enrichment-scorecard/sampled-regression-packet.json` covers:

- duplicate same-head comments
- stale-head posts
- invalid inline coordinates
- issue-enrichment permission failure
- launchd/config/head ambiguity
- docs-only fast negative control
- old-backlog negative control
- external-precedent-required issue
- stale or irrelevant web result
- 30-PR provider-failure burst simulation

## Proof Boundary

The fixture packet is advisory fixture scoring only. It can show whether the scorecard contract, evidence-link requirements, negative controls, and unmeasurable-state handling are executable. It cannot prove live issue-comment quality, public product parity, calibrated model confidence, provider reliability, launchd safety, or release readiness.

## Known Limitations

- The sampled packet uses seeded regression expectations, not statistically calibrated production labels.
- The 30-PR provider-failure burst is simulated and does not call live GitHub or provider APIs.
- External precedent coverage is represented by sampled fixture cells, not a full current-web retrieval benchmark.
- The evaluator does not post comments, mutate labels, update assignees, change config, restart launchd, tag, release, or promote runtime state.
