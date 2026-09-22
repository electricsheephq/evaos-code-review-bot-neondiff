import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { PullFilePatch } from "./types.js";
import { extractJsonObject } from "./zcode.js";
import { isLcmReviewRepository, LCM_REVIEW_REPOSITORY } from "./lcm-review-repository.js";

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
  if (!isLcmReviewRepository(input.repo) || !input.complete || input.droppedFindingCount !== 0 ||
      !Number.isInteger(input.prNumber) || input.prNumber <= 0 ||
      !/^[a-f0-9]{40}$/.test(input.baseSha) || !/^[a-f0-9]{40}$/.test(input.headSha)) return;
  if (containsSecretLikeText(input.rawResponse)) return;
  let result: unknown;
  try { result = JSON.parse(extractJsonObject(input.rawResponse)); } catch { return; }
  if (!record(result) || !Array.isArray(result.findings) || "chunks" in result) return;
  const assessment = result.review_assessment;
  if (!record(assessment) ||
      Object.keys(assessment).sort().join(",") !== "acceptance_evidence,limitations,scope,unresolved_findings,verdict" ||
      typeof assessment.verdict !== "string" ||
      !["PASS", "BLOCKED", "ABSTAIN"].includes(assessment.verdict) ||
      !text(assessment.scope) || !texts(assessment.unresolved_findings) ||
      !texts(assessment.limitations) || !texts(assessment.acceptance_evidence) ||
      assessment.acceptance_evidence.length === 0) return;
  const unresolvedFindings = assessment.unresolved_findings as string[];
  const findingTitles = result.findings.map(findingTitle);
  if (findingTitles.some((title) => title === undefined) ||
      findingTitles.length !== unresolvedFindings.length ||
      findingTitles.some((title, index) => title !== unresolvedFindings[index])) return;
  // Finding filters may suppress public comments; they cannot upgrade or erase the review.
  if (assessment.verdict === "PASS" && findingTitles.length !== 0) return;
  const assessmentText = [assessment.scope, ...unresolvedFindings, ...assessment.limitations, ...assessment.acceptance_evidence];
  if (assessmentText.some((value) => value.includes("<!--") || value.includes("-->"))) return;
  const body = JSON.stringify({
    schema_version: "2", repository: LCM_REVIEW_REPOSITORY, pr_number: input.prNumber,
    base_sha: input.baseSha, head_sha: input.headSha, lane: "acceptance",
    verdict: assessment.verdict, scope: assessment.scope, findings: unresolvedFindings,
    limitations: assessment.limitations, acceptance_evidence: assessment.acceptance_evidence, policy_version: "2"
  });
  // Keep the exact assessment or omit it. Redaction must not rewrite its meaning.
  if (Buffer.byteLength(body) > 8000 || redactSecrets(body) !== body) return;
  return `<!-- lcm-x-ai-review:v2\n${body}\n-->`;
}

/** Only exact, untruncated patches inside the provider budget can establish full coverage. */
export function lcmReviewPatchSetIsComplete(files: PullFilePatch[], maxPatchBytes: number): boolean {
  return Number.isInteger(maxPatchBytes) && maxPatchBytes >= 0 &&
    files.every((file) => file.patchComplete === true && typeof file.patch === "string") &&
    files.reduce((bytes, file) => bytes + Buffer.byteLength(file.patch ?? ""), 0) <= maxPatchBytes;
}

/** Keep original prose and assessment intact within the consumer's whole-body limit. */
export function appendLcmReviewAssessment(body: string, assessment: string | undefined, repo: string): string {
  if (isLcmReviewRepository(repo)) assertOrdinaryLcmReviewBodySafe(body);
  if (!assessment) return body;
  const combined = [body, assessment].filter(Boolean).join("\n\n");
  return Buffer.byteLength(combined, "utf8") <= 8192 ? combined : body;
}

export function assertOrdinaryLcmReviewBodySafe(body: string): void {
  if (body.includes("<!-- lcm-x-ai-review:v2")) throw new Error("ordinary review body contains the reserved LCM assessment marker");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function findingTitle(value: unknown): string | undefined {
  return record(value) && text(value.title) ? value.title : undefined;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
}
function texts(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 30 && value.every(text);
}
