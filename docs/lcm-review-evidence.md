# Original LCM-X review assessments

For `electricsheephq/lcm-x`, the normal reviewer prompt requests an explicit
`review_assessment` from the provider: `PASS`, `BLOCKED` or `ABSTAIN`, inspected
scope, unresolved findings, limitations and acceptance evidence. The Codex
runtime requests those fields in its strict output schema only for that repo.

The worker appends a terminal `lcm-x-ai-review:v2` assessment to the normal
human-readable review body only when that original
assessment is valid and the review was a complete, single execution. Filtered
files, missing/truncated patches, chunked review or invalid findings cannot
produce a gate assessment. Missing assessment data leaves the ordinary review
body unchanged; neither zero findings nor a `COMMENT` event is converted into
`PASS`. Contradictory `PASS` plus findings is rejected. Sensitive text causes
the assessment to be omitted, not rewritten into an apparent original verdict.
The combined human-readable body and assessment must fit the consumer’s 8192-byte
UTF-8 limit. Otherwise only the original human-readable review is posted; no
assessment is truncated or substituted.

The wrapper binds repository, PR, base/head and the acceptance lane to the
reviewed job. It maps the model's `unresolved_findings` to the public `findings`
field without changing content. GitHub supplies the review author and creation
metadata. No score, fabricated reviewer timestamp or reviewer-issued receipt ID
is added. Existing posting authorization and stale-head checks still apply;
the GitHub event remains `COMMENT` or authorized `REQUEST_CHANGES`, never
automatic approval.

Dry runs retain `lcm-review-assessment.md` alongside existing evidence when a
valid assessment is present. A separate consumer must fetch the original review
and check its identity, commit, scope and verdict. This publisher does not clear
protected checks, attest to runtime behavior, or provide the separate adversarial
review required for a named risk.

Source tests use synthetic results. Deployment and a real independent review
remain required before claiming the publisher is active.
