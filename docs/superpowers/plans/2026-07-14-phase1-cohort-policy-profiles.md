# Phase 1 Cohort Policy Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fail-closed natural-quality cohort profile without changing the existing stratified-transport selection contract, while naming deterministic prompt-size estimates honestly.

**Architecture:** Model policy and selection manifests as discriminated unions keyed by `selectionProfile`. Route transport through the existing quota/backtracking/first-five path and route natural quality through exact-pool validation and deterministic ordering, then emit profile-specific manifest fields from the shared sealing path.

**Tech Stack:** TypeScript, Node.js filesystem/crypto APIs, Vitest, npm/tsx CLI.

## Global Constraints

- `natural_quality` requires exactly 14 input candidates and exactly four clean controls; the fifth reserve is outside the input.
- `stratified_transport` preserves the existing 2/5/5/2 quotas, 1/2/1/1 first-five behavior, 8,193-estimate lower bound, search algorithm, and all existing floors and caps.
- Both profiles preserve eligibility, diversity, lineage uniqueness, path-boundary, input-integrity, secret-scan, redaction, source-policy, output-budget, and resource-bound checks.
- Use `admissionEstimatedPromptTokens` and `admissionEstimatorFingerprint`; accept no compatibility aliases for `promptTokens` or `tokenizerFingerprint`.
- Natural observed size bands are derived evidence only and do not influence selection.
- Do not merge, deploy, alter runtime/configuration, execute models, or claim quality.

---

### Task 1: Profile-aware policy, candidate, selection, and sealed manifests

**Files:**
- Modify: `src/phase1-cohort-selection.ts`
- Test: `tests/phase1-cohort-selection.test.ts`

**Interfaces:**
- Consumes: pinned candidate-pool JSON, pinned policy JSON, and existing `Phase1CohortSelectionOptions`.
- Produces: `Phase1CohortPolicy` as a `stratified_transport | natural_quality` union, profile-bearing `Phase1SelectionResult`, and profile-specific immutable artifacts.

- [ ] **Step 1: Rename test fixtures and add failing natural-profile tests**

Update the shared candidate fixture to emit:

```ts
admissionEstimatedPromptTokens,
bucket
```

Update the transport policy fixture to emit:

```ts
selectionProfile: "stratified_transport",
admissionEstimatorFingerprint: digest("admission-estimator")
```

Add `naturalPolicy()` and `naturalCandidatePool()` fixtures. The natural pool contains exactly 14 rows, exactly four controls, positive estimates including values below 8,193, unique lineage IDs, at least six repository groups, at least five languages, and at least five high-risk rows. Assert that sealing:

```ts
expect(manifest.selectionProfile).toBe("natural_quality");
expect(manifest.selectedCandidateIds).toHaveLength(14);
expect(manifest.strata.admissionEstimatedPromptBucketCounts).toEqual({
  "16k": expected16k,
  "32k": expected32k,
  "64k": expected64k,
  "128k": expected128k
});
expect(manifest.diversity.cleanControlCount).toBe(4);
expect(manifest).not.toHaveProperty("firstFive");
expect(manifest.contract).not.toHaveProperty("bucketQuotas");
expect(manifest.contract).not.toHaveProperty("firstFiveBucketQuotas");
expect(manifest.fingerprints).toHaveProperty("admissionEstimator");
expect(manifest.fingerprints).not.toHaveProperty("tokenizer");
```

Add table-driven rejection cases for 13/15 rows, 3/5 controls, duplicate lineage, insufficient repository/language/high-risk diversity, repository cap violation, ineligible rows, zero/over-131,072 estimates, quota keys on natural policy, and old estimator field names. Retain transport assertions for exact quotas, first-five counts, and rejection below 8,193.

- [ ] **Step 2: Run the focused tests and verify the RED state**

Run:

```bash
npm test -- --run tests/phase1-cohort-selection.test.ts
```

Expected: FAIL because the exported candidate/policy types and parser do not yet accept `selectionProfile`, `admissionEstimatedPromptTokens`, `admissionEstimatorFingerprint`, or natural-quality policy shape.

- [ ] **Step 3: Implement discriminated candidate/policy/manifest contracts**

In `src/phase1-cohort-selection.ts`, define:

```ts
type Phase1SelectionProfile = "stratified_transport" | "natural_quality";

interface Phase1CohortPolicyBase {
  selectionProfile: Phase1SelectionProfile;
  cohortSize: number;
  outputTokens: number;
  maximumFindings: number;
  minimumCleanControls: number;
  minimumRepositoryGroups: number;
  minimumLanguages: number;
  minimumHighRisk: number;
  maximumPerRepositoryGroup: number;
  maximumCandidatePoolSize: number;
  maximumCanonicalSearchStates: number;
  selectionSeed: string;
  admissionEstimatorFingerprint: string;
  promptBuilderFingerprint: string;
  parserFingerprint: string;
  gateFingerprint: string;
  redactorFingerprint: string;
  secretScannerFingerprint: string;
  sourcePolicyFingerprint: string;
  safeOutputRoot: string;
  proofBoundary: string;
}

interface Phase1StratifiedTransportPolicy extends Phase1CohortPolicyBase {
  selectionProfile: "stratified_transport";
  bucketQuotas: BucketCounts;
  firstFiveBucketQuotas: BucketCounts;
}

interface Phase1NaturalQualityPolicy extends Phase1CohortPolicyBase {
  selectionProfile: "natural_quality";
}

export type Phase1CohortPolicy =
  | Phase1StratifiedTransportPolicy
  | Phase1NaturalQualityPolicy;
```

Rename `Phase1Candidate.promptTokens` to `admissionEstimatedPromptTokens`. Use profile-specific exact policy key lists so natural forbids quota keys and transport requires them. Validate all fingerprint fields as SHA-256, pin common frozen values, pin `minimumCleanControls` to four, and retain the current exact transport quotas.

Use a profile-aware candidate estimate validator:

```ts
function admissionEstimatedBucket(tokens: number): Phase1Bucket {
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 131_072) {
    throw new Error("admission estimated prompt tokens must be an integer between 1 and 131072");
  }
  if (tokens <= 16_384) return "16k";
  if (tokens <= 32_768) return "32k";
  if (tokens <= 65_536) return "64k";
  return "128k";
}
```

For transport, additionally reject estimates below 8,193 and require supplied `bucket` to match the derived band. Natural still validates the supplied bucket as an honest observed band but does not use it as an admission quota.

- [ ] **Step 4: Implement profile-specific selection and manifest emission**

Retain the existing `selectCandidates()` and `selectFirstFive()` functions with a narrowed `Phase1StratifiedTransportPolicy` parameter. Add:

```ts
function selectNaturalQualityCandidates(
  candidates: Phase1Candidate[],
  policy: Phase1NaturalQualityPolicy
): Phase1Candidate[] {
  if (candidates.length !== 14) {
    throw new Error("natural-quality candidate pool must contain exactly 14 rows");
  }
  const selected = [...candidates].sort((left, right) =>
    compareCodeUnits(seededRank(left, policy.selectionSeed), seededRank(right, policy.selectionSeed)) ||
    compareCodeUnits(left.candidateId, right.candidateId));
  assertSelectedCohortInvariants(selected, policy);
  if (selected.filter(isCleanControl).length !== 4) {
    throw new Error("natural-quality cohort must contain exactly four clean controls");
  }
  return selected;
}
```

Extract the existing shared selected-cohort floor/cap/lineage assertions into `assertSelectedCohortInvariants()`. Build a common manifest base containing `selectionProfile`, renamed fingerprints, selected IDs, derived `admissionEstimatedPromptBucketCounts`, case-kind counts, and diversity. For transport, spread in quota contracts and `firstFive`; for natural, do not create those properties. Rename the runtime input field to `admissionEstimatedPromptTokens` and bind `selectionProfile` in the receipt so each artifact set is self-describing.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```bash
npm test -- --run tests/phase1-cohort-selection.test.ts
```

Expected: all Phase 1 cohort-selection tests pass, including the unchanged transport cases and new natural-quality failure cases.

- [ ] **Step 6: Commit the profile-aware core**

```bash
git add src/phase1-cohort-selection.ts tests/phase1-cohort-selection.test.ts
git commit -m "feat: add natural quality cohort profile"
```

### Task 2: Profile-aware CLI and operator documentation

**Files:**
- Modify: `src/phase1-cohort-selection-cli.ts`
- Modify: `docs/eval-harness.md`
- Test: `tests/phase1-cohort-selection.test.ts`

**Interfaces:**
- Consumes: `selectionProfile` returned by `selectAndSealPhase1Cohort()` and `verifyPhase1CohortSeal()`.
- Produces: CLI JSON containing `{ ok, command, selectionProfile, manifestSha256 }` and operator documentation for both policy profiles.

- [ ] **Step 1: Add failing CLI and documentation assertions**

Update CLI tests to expect:

```ts
{
  ok: true,
  command: "select",
  selectionProfile: "stratified_transport",
  manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/)
}
```

Exercise the package command once with `natural_quality` and expect that profile in both `select` and `verify` output. Assert `--help` mentions that profile is policy-bound. Assert `docs/eval-harness.md` names both `stratified_transport` and `natural_quality`, distinguishes enforced transport quotas from natural observed estimator bands, and states that admission estimates are not exact provider/backend token counts.

- [ ] **Step 2: Run the focused tests and verify the RED state**

Run:

```bash
npm test -- --run tests/phase1-cohort-selection.test.ts
```

Expected: FAIL because the CLI result does not yet expose `selectionProfile` and the documentation lacks the profile contract.

- [ ] **Step 3: Return the bound profile from select and verify**

Change the public result shapes so both core operations return `selectionProfile`. Update `Phase1CohortSelectionCliResult` and the success return:

```ts
return {
  ok: true,
  command,
  selectionProfile: result.selectionProfile,
  manifestSha256: result.manifestSha256
};
```

Append `policy selects stratified_transport or natural_quality` to the CLI usage string without adding mutable flags; the policy SHA remains the profile trust pin.

- [ ] **Step 4: Document both policy shapes and proof boundaries**

In `docs/eval-harness.md`, retain the existing select/verify commands. Add concise JSON policy fragments for each discriminator and state:

- transport alone enforces 2/5/5/2 and legacy first-five 1/2/1/1;
- natural requires exactly 14 exposed rows and exactly four controls, has no quota or first-five keys, and reports the natural estimated distribution;
- `admissionEstimatedPromptTokens` and `admissionEstimatorFingerprint` describe deterministic admission estimates, never exact provider/backend model token counts;
- both remain advisory/offline and do not wire model execution, CI enforcement, runtime defaults, or production posting.

- [ ] **Step 5: Run focused tests, build, and static proof checks**

Run:

```bash
npm test -- --run tests/phase1-cohort-selection.test.ts
npm run build
npm run postbuild
git diff --check
```

Expected: focused tests pass; build and postbuild exit 0; diff check emits no output.

- [ ] **Step 6: Run the repository's tracked-file secret scan and inspect the bounded diff**

Run the repository's tracked-file secret scan, then inspect the bounded amendment diff:

```bash
npm run check:secrets
git diff --stat 8d2dc971f94b82ce5fade6256bae1f04c16992ae...HEAD
git diff --check 8d2dc971f94b82ce5fade6256bae1f04c16992ae...HEAD
git status --short
```

Expected: secret scan reports zero findings; only the cohort selector, CLI, focused tests, harness docs, and approved spec/plan changed; worktree is clean after the final commit.

- [ ] **Step 7: Commit, push, and settle current-head review surfaces**

```bash
git add src/phase1-cohort-selection-cli.ts docs/eval-harness.md tests/phase1-cohort-selection.test.ts docs/superpowers/plans/2026-07-14-phase1-cohort-policy-profiles.md
git commit -m "docs: expose cohort selection profiles"
git push origin codex/566-cohort-selection-seal
```

Hydrate exact-head GitHub checks, CodeQL alerts, check annotations, top-level comments, and paginated review threads. Fix only actionable findings within this amendment, reply and resolve current-head threads, rerun focused proof after any edit, and report merge/release/runtime as unproven.
