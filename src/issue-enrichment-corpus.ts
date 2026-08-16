import { createHash } from "node:crypto";

export type IssueCorpusArtifactKind = "issue_body" | "comment" | "timeline" | "linked_item" | "source";
export type IssueCorpusMetricId =
  | "relatedWork" | "disposition" | "nextGate" | "labelProposals" | "limitations" | "novelVerifiedFacts";

export interface IssueCorpusScenario {
  schemaVersion: "neondiff-issue-corpus/v1";
  id: string;
  repository: { name: string; defaultBranch: string; defaultBranchSha: string };
  complete: { comments: boolean; timeline: boolean; linkedItems: boolean };
  artifacts: Array<{ id: string; kind: IssueCorpusArtifactKind; content: string; sha256: string }>;
  gold: {
    source: "human_adjudication";
    facts: Array<{ claim: string; evidenceRefs: string[] }>;
  };
  control: "standard" | "preservation";
  protectedCanaries: string[];
}

export interface IssueCorpusCandidate {
  verifiedFacts: Array<{ claim: string; evidenceRefs: string[] }>;
  providerInvocations: number;
  commentMutations: number;
  stickyOutputHashes: string[];
  [key: string]: unknown;
}

export interface IssueCorpusJudgments extends Record<IssueCorpusMetricId, boolean[]> {
  factEntailment: boolean[];
}

export interface IssueCorpusMetric {
  successes: number;
  total: number;
  lowerBound95: number;
  passed: boolean;
}

const ARTIFACT_KINDS: IssueCorpusArtifactKind[] = ["issue_body", "comment", "timeline", "linked_item", "source"];
const METRICS: IssueCorpusMetricId[] = [
  "relatedWork", "disposition", "nextGate", "labelProposals", "limitations", "novelVerifiedFacts"
];
const SHA = /^[0-9a-f]{64}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function validateIssueCorpusScenario(scenario: IssueCorpusScenario): string[] {
  const errors: string[] = [];
  if (scenario.schemaVersion !== "neondiff-issue-corpus/v1") errors.push("unsupported schemaVersion");
  if (!scenario.id.trim()) errors.push("scenario id is required");
  if (!scenario.repository.name.includes("/") || !scenario.repository.defaultBranch.trim()) errors.push("repository identity is invalid");
  if (!COMMIT_SHA.test(scenario.repository.defaultBranchSha)) errors.push("default branch SHA is invalid");
  if (!scenario.complete.comments || !scenario.complete.timeline || !scenario.complete.linkedItems) {
    errors.push("comments, timeline, and linked items must be complete");
  }
  const ids = new Set<string>();
  for (const artifact of scenario.artifacts) {
    if (!artifact.id.trim() || ids.has(artifact.id)) errors.push(`duplicate or empty artifact id ${artifact.id}`);
    ids.add(artifact.id);
    if (!SHA.test(artifact.sha256) || digest(artifact.content) !== artifact.sha256) {
      errors.push(`artifact hash mismatch ${artifact.id}`);
    }
  }
  for (const kind of ARTIFACT_KINDS) {
    if (!scenario.artifacts.some((artifact) => artifact.kind === kind)) errors.push(`missing artifact kind ${kind}`);
  }
  if (scenario.gold.source !== "human_adjudication") errors.push("gold source must be human_adjudication");
  for (const fact of scenario.gold.facts) {
    if (!fact.claim.trim() || fact.evidenceRefs.length === 0) errors.push("gold fact claim and evidence refs are required");
    for (const ref of fact.evidenceRefs) if (!ids.has(ref)) errors.push(`unresolved gold evidence ref ${ref}`);
  }
  if (scenario.protectedCanaries.length === 0 || scenario.protectedCanaries.some((value) => !value)) {
    errors.push("protected canaries are required");
  }
  return errors;
}

export function evaluateIssueCorpus(input: {
  scenario: IssueCorpusScenario;
  candidate: IssueCorpusCandidate;
  judgments: IssueCorpusJudgments;
}): { passed: boolean; failures: string[]; metrics: Record<IssueCorpusMetricId, IssueCorpusMetric> } {
  const failures = validateIssueCorpusScenario(input.scenario);
  const ids = new Set(input.scenario.artifacts.map((artifact) => artifact.id));
  if (input.judgments.factEntailment.length !== input.candidate.verifiedFacts.length) failures.push("fact adjudication denominator mismatch");
  input.candidate.verifiedFacts.forEach((fact, index) => {
    if (!fact.evidenceRefs.length || fact.evidenceRefs.some((ref) => !ids.has(ref))) failures.push(`unsupported fact ${index}: unresolved evidence`);
    if (input.judgments.factEntailment[index] !== true) failures.push(`unsupported fact ${index}: not entailed`);
  });
  if (input.scenario.control === "preservation" && input.candidate.providerInvocations !== 0) failures.push("preservation provider invocation");
  if (input.scenario.control === "preservation" && input.candidate.commentMutations !== 0) failures.push("preservation comment mutation");
  if (input.candidate.stickyOutputHashes.length < 2 || new Set(input.candidate.stickyOutputHashes).size !== 1) failures.push("sticky output is not idempotent");
  const serialized = JSON.stringify(input.candidate);
  if (input.scenario.protectedCanaries.some((canary) => serialized.includes(canary))) failures.push("protected canary leaked");
  const metrics = Object.fromEntries(METRICS.map((id) => [id, metric(input.judgments[id])])) as Record<IssueCorpusMetricId, IssueCorpusMetric>;
  for (const id of METRICS) if (!metrics[id].passed) failures.push(`${id} lower bound below 0.9`);
  return { passed: failures.length === 0, failures, metrics };
}

function metric(judgments: boolean[]): IssueCorpusMetric {
  const successes = judgments.filter(Boolean).length;
  const total = judgments.length;
  const lowerBound95 = wilsonLowerBound(successes, total);
  return { successes, total, lowerBound95, passed: lowerBound95 >= 0.9 };
}

function wilsonLowerBound(successes: number, total: number): number {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) return 0;
  const z = 1.6448536269514722;
  const p = successes / total;
  return (p + z * z / (2 * total) - z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)) / (1 + z * z / total);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
