# Confidence Calibration And Public Display Policy

NeonDiff stores model confidence as internal review metadata. Public comments
must remain uncalibrated and must not show confidence percentages until a
calibration report proves every public-display threshold.

## Public Display Gate

Public confidence display is allowed only when all of these are true:

- The public display policy mode is `calibrated`.
- The report links an HTTPS evidence URL.
- The report names a non-empty dataset id.
- The evaluated dataset has at least 100 labeled findings.
- The evaluated dataset has at least 30 P0/P1-equivalent labels.
- The evaluated dataset has at least 10 negative-control scenarios.
- The measured Wilson lower bound is at least 0.95.

These numbers are hard floors. Operators may configure stricter minimums, and
the report reflects those stricter values in `metrics.*.required`.
Malformed minimums fail closed with `blockedReason: malformed_minimum`; finite
malformed inputs are shown as `metrics.*.rejectedMinimum` while `required`
remains the hard floor.

If any field is missing, malformed, or below threshold, the public mode is
`uncalibrated`. Public comment text must continue replacing confidence values
with `[confidence not calibrated]`.

## Calibration Report Contract

The auditable report must include:

- `dataset.id`: stable dataset or suite id.
- `dataset.evidenceUrl`: HTTPS link to the CI run, eval packet, or durable proof
  bundle.
- `labels.labeledFindings`: total labeled findings counted for calibration.
- `labels.p0p1Labels`: P0/P1-equivalent labels counted for severe findings.
- `labels.negativeControlScenarios`: negative-control PRs or scenarios.
- `metrics.wilsonLowerBound`: measured Wilson lower bound and required floor.
- `proofBoundary`: whether public comments may display percentages, or why they
  must remain uncalibrated.

The report is a proof boundary, not a permanent feature flag. Public confidence
percentages may appear only while the linked dataset and metrics still satisfy
the policy.

## REQUEST_CHANGES Audit Policy

`REQUEST_CHANGES` confidence claims require calibrated P0/P1 bins that pass the
same public display policy. High-severity findings may still be posted or used
for review events according to the existing review policy, but the public
comment must not imply 95% confidence until the calibration report passes.

The default stance is conservative: uncalibrated text is public-safe, raw model
confidence remains internal, and 95% public claims wait for measured evidence.
