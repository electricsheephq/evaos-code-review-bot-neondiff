import { redactSecrets } from "./secrets.js";
import { extractJsonObject } from "./zcode.js";

export const LCM_REVIEW_ASSESSMENT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["verdict", "scope", "unresolved_findings", "limitations", "acceptance_evidence"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "BLOCKED", "ABSTAIN"] },
    scope: { type: "string", minLength: 1, maxLength: 2000 },
    unresolved_findings: { type: "array", items: { type: "string" }, maxItems: 30 },
    limitations: { type: "array", items: { type: "string" }, maxItems: 30 },
    acceptance_evidence: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30 }
  }
} as const;

/** Publish an explicit provider assessment; never turn zero findings into PASS. */
export function buildLcmReviewAssessmentBody(input: {
  repo: string; prNumber: number; baseSha: string; headSha: string;
  rawResponse: string; complete: boolean; droppedFindingCount: number;
}): string | undefined {
  if (input.repo !== "electricsheephq/lcm-x" || !input.complete || input.droppedFindingCount !== 0 ||
      !Number.isInteger(input.prNumber) || input.prNumber <= 0 ||
      !/^[a-f0-9]{40}$/.test(input.baseSha) || !/^[a-f0-9]{40}$/.test(input.headSha)) return;
  let result: unknown;
  try { result = JSON.parse(extractJsonObject(input.rawResponse)); } catch { return; }
  if (!record(result) || !Array.isArray(result.findings) || "chunks" in result) return;
  const assessment = result.review_assessment;
  if (!record(assessment) ||
      Object.keys(assessment).sort().join(",") !== "acceptance_evidence,limitations,scope,unresolved_findings,verdict" ||
      !["PASS", "BLOCKED", "ABSTAIN"].includes(String(assessment.verdict)) ||
      !text(assessment.scope) || !texts(assessment.unresolved_findings) ||
      !texts(assessment.limitations) || !texts(assessment.acceptance_evidence) ||
      assessment.acceptance_evidence.length === 0) return;
  // Finding filters may suppress public comments; they cannot upgrade the review.
  if (assessment.verdict === "PASS" && (result.findings.length !== 0 || assessment.unresolved_findings.length !== 0)) return;
  const body = JSON.stringify({
    schema_version: "2", repository: input.repo, pr_number: input.prNumber,
    base_sha: input.baseSha, head_sha: input.headSha, lane: "acceptance",
    verdict: assessment.verdict, scope: assessment.scope, findings: assessment.unresolved_findings,
    limitations: assessment.limitations, acceptance_evidence: assessment.acceptance_evidence, policy_version: "2"
  });
  // Keep the exact assessment or omit it. Redaction must not rewrite its meaning.
  if (Buffer.byteLength(body) > 8000 || redactSecrets(body) !== body) return;
  return `<!-- lcm-x-ai-review:v2\n${body}\n-->`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 30 && value.every(text);
}
