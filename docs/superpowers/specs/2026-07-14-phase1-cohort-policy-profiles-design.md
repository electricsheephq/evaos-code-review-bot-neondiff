# Phase 1 Cohort Policy Profiles Design

## Context

The Phase 1 selector currently treats the 14-case quality cohort as if it must satisfy the frozen 2/5/5/2 16k/32k/64k/128k transport matrix. The source-state audit established that the quality cohort is instead ten natural defect-present production prompts plus exactly four independently verified clean controls. Its natural serialized prompt sizes must be observed, not inflated or rejected to satisfy transport quotas.

The current `promptTokens` and `tokenizerFingerprint` names also overstate what the admission path knows. Admission uses a deterministic prompt-size estimator. Actual provider/backend prompt-token counts are separate execution evidence and may not exist when the cohort is sealed.

## Approved Approach

Add an explicit policy profile while preserving one shared sealed-artifact path:

- `stratified_transport` retains the existing 2/5/5/2 quota selector, legacy first-five 1/2/1/1 behavior, deterministic canonical search, and all existing floors, caps, eligibility checks, path protections, and resource bounds.
- `natural_quality` accepts only an input pool of exactly 14 eligible candidates, including exactly four clean controls. The fifth reserve control must stay outside the input. It deterministically orders and seals those 14 candidates without bucket quotas or a first-five contract.

Both profiles retain the existing minimum repository-group, language, high-risk, lineage-uniqueness, per-repository, output-budget, candidate-pool, search-budget, fingerprint, proof-boundary, redaction, secret-scan, source-policy, and immutable-input checks. Natural quality keeps the same maximum serialized-prompt admission bound while accepting estimates below the transport floor.

## Honest Estimator Semantics

Rename estimator-bearing fields throughout candidate input, policy input, sealed manifests, and runtime input:

- `promptTokens` becomes `admissionEstimatedPromptTokens`.
- `tokenizerFingerprint` becomes `admissionEstimatorFingerprint`.
- Manifest fingerprint and observed-distribution fields use `admissionEstimator` / `admissionEstimated...` language.

No compatibility alias is accepted. Exact-key validation rejects the old names so a deterministic estimate cannot be mistaken for an exact model/provider tokenizer count.

Natural quality derives observed upper-bound bands from the estimate: `16k` includes positive estimates through 16,384; subsequent bands retain the existing 32k, 64k, and 128k upper bounds. Those counts are evidence only and never influence admission or ordering. Transport retains its current 8,193 lower bound and exact declared-bucket validation.

## Policy And Manifest Shape

The policy is a discriminated union:

- Shared fields contain the frozen output/resource/diversity/security/fingerprint contracts.
- `stratified_transport` additionally requires `bucketQuotas` and `firstFiveBucketQuotas` with their existing frozen values.
- `natural_quality` forbids both quota fields and pins an exact clean-control count of four.

The selection manifest becomes profile-aware:

- Both profiles bind the selected profile, all shared fingerprints/contracts, selected IDs, observed estimated-size distribution, case-kind counts, and diversity evidence.
- Transport additionally binds enforced bucket quotas and the legacy `firstFive` object.
- Natural quality omits `firstFive` and all bucket-quota contract fields.

Verification rebuilds the profile-specific artifact bytes from the pinned candidate and policy inputs, preserving the existing immutable-seal behavior.

## CLI And Documentation

The existing `npm run eval:phase1-cohort -- <select|verify>` interface remains the only invocation path. Successful CLI output includes the bound profile so operators can distinguish natural-quality evidence from stratified-transport evidence without opening the manifest. Help and harness documentation describe both policy shapes and state that observed natural bands are non-enforcing estimator output, not exact provider token counts.

## Test Strategy

Add failing tests before implementation for:

1. a natural-quality pool of exactly 14 natural-sized prompts and exactly four controls seals successfully, records observed estimated bands, and omits `firstFive` and quota contracts;
2. natural quality rejects 13 or 15 candidates and rejects three or five controls;
3. natural quality preserves all existing eligibility, diversity, lineage, per-repository, and resource invariants;
4. transport retains its exact quotas, first-five behavior, and lower token-estimate floor;
5. legacy estimator field names are rejected;
6. CLI select/verify output reports the profile and documentation identifies both profiles and the estimator proof boundary.

Focused tests, build/postbuild, tracked-file secret scan, and diff checks provide local proof. Remote CI and review surfaces remain separate gates. This amendment does not merge, deploy, configure runtime, execute models, or admit quality claims.
