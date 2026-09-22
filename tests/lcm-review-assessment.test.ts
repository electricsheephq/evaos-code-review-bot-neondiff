import { describe, expect, it } from "vitest";
import { buildLcmReviewAssessmentBody } from "../src/lcm-review-assessment.js";

const assessment = {
  verdict: "PASS", scope: "Changed validator and workflow only",
  unresolved_findings: [], limitations: ["No deployment or runtime proof"],
  acceptance_evidence: ["Validator compares the final fetched original assessment"]
};
const input = {
  repo: "electricsheephq/lcm-x", prNumber: 466,
  baseSha: "a".repeat(40), headSha: "b".repeat(40),
  rawResponse: JSON.stringify({ findings: [], review_assessment: assessment }),
  complete: true, droppedFindingCount: 0
};

describe("original LCM reviewer assessment", () => {
  it("rejects array verdicts even when their string conversion is PASS", () => {
    expect(buildLcmReviewAssessmentBody({ ...input, rawResponse: JSON.stringify({
      findings: [{ title: "A blocking finding" }], review_assessment: {
        ...assessment, verdict: ["PASS"], unresolved_findings: ["A blocking finding"]
      }
    }) })).toBeUndefined();
  });
  it("preserves the original verdict, evidence and limitations without adding scores", () => {
    const body = buildLcmReviewAssessmentBody(input)!;
    const parsed = JSON.parse(body.split("\n")[1]!);
    expect(parsed).toMatchObject({ verdict: assessment.verdict, scope: assessment.scope, findings: [],
      limitations: assessment.limitations, acceptance_evidence: assessment.acceptance_evidence, repository: input.repo,
      pr_number: 466, base_sha: input.baseSha, head_sha: input.headSha,
      lane: "acceptance", schema_version: "2", policy_version: "2" });
    expect(body).not.toMatch(/score|receipt_id|issued_at|expires_at/);
  });
  it.each(["BLOCKED", "ABSTAIN"])("preserves explicit %s rather than promoting it", (verdict) => {
    const body = buildLcmReviewAssessmentBody({ ...input,
      rawResponse: JSON.stringify({ findings: [], review_assessment: { ...assessment, verdict } }) });
    expect(body).toContain(`"verdict":"${verdict}"`);
  });
  it.each([
    { findings: [] },
    { findings: [], review_assessment: { ...assessment, verdict: "COMMENT" } },
    { findings: [], review_assessment: { ...assessment, score: 100 } },
    { findings: [], review_assessment: { ...assessment, acceptance_evidence: [] } },
    { findings: [], review_assessment: { ...assessment, unresolved_findings: ["Blocking flaw"] } },
    { findings: [{ title: "A dropped or filtered finding" }], review_assessment: assessment },
    { findings: [], chunks: [{ review_assessment: assessment }] }
  ])("does not infer a passing assessment from incomplete or contradictory output", (output) => {
    expect(buildLcmReviewAssessmentBody({ ...input, rawResponse: JSON.stringify(output) })).toBeUndefined();
  });
  it("does not publish partial, unvalidated or unrelated-repo evidence", () => {
    expect(buildLcmReviewAssessmentBody({ ...input, complete: false })).toBeUndefined();
    expect(buildLcmReviewAssessmentBody({ ...input, droppedFindingCount: 1 })).toBeUndefined();
    expect(buildLcmReviewAssessmentBody({ ...input, repo: "example/another" })).toBeUndefined();
    expect(buildLcmReviewAssessmentBody({ ...input, headSha: "unknown" })).toBeUndefined();
  });
  it("rejects sensitive text instead of laundering it into an unchanged verdict", () => {
    const rawResponse = JSON.stringify({ findings: [], review_assessment: {
      ...assessment, scope: "AWS access key AKIAIOSFODNN7EXAMPLE"
    } });
    expect(buildLcmReviewAssessmentBody({ ...input, rawResponse })).toBeUndefined();
  });
});
