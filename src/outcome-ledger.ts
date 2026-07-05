import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { PullFilePatch, PullRequestSummary, ReviewPlan } from "./types.js";

export type OutcomeLedgerSubjectType = "pull_request" | "issue";
export type OutcomeLedgerMode =
  | "stable"
  | "advanced_dry_run"
  | "advanced_pr_review"
  | "advanced_issue_research"
  | "advanced_full";
export type OutcomeLedgerDecisionStatus =
  | "block"
  | "warn"
  | "accept_with_evidence"
  | "defer"
  | "human_review"
  | "unknown";
export type OutcomeLedgerSafetyGateStatus = "pass" | "fail" | "not_applicable" | "unknown";
export type OutcomeLedgerPostMergeStatus =
  | "unknown"
  | "not_merged"
  | "no_incident_seen"
  | "regression_seen"
  | "reverted"
  | "hotfixed";

export interface OutcomeLedgerInput {
  ledgerName?: string;
  runId: string;
  mode?: OutcomeLedgerMode;
  subject: OutcomeLedgerSubjectInput;
  intent?: OutcomeLedgerIntentInput;
  changedArtifacts?: OutcomeLedgerChangedArtifactInput[];
  evidence?: OutcomeLedgerEvidenceInput[];
  riskClaims?: OutcomeLedgerRiskClaimInput[];
  proofGaps?: OutcomeLedgerProofGapInput[];
  safetyGates?: OutcomeLedgerSafetyGateInput[];
  reviewerDecision?: OutcomeLedgerReviewerDecisionInput;
  runtime?: OutcomeLedgerRuntimeInput;
  postMergeOutcome?: OutcomeLedgerPostMergeOutcomeInput;
}

export interface OutcomeLedgerSubjectInput {
  type: OutcomeLedgerSubjectType;
  repo: string;
  number: number;
  title?: string;
  url?: string;
  baseSha?: string;
  headSha?: string;
  author?: string;
  labels?: string[];
}

export interface OutcomeLedgerIntentInput {
  summary?: string;
  sourceIssue?: string;
  acceptanceCriteria?: string[];
  nonGoals?: string[];
}

export interface OutcomeLedgerChangedArtifactInput {
  path: string;
  changeType?: "added" | "modified" | "removed" | "renamed" | "unknown";
  summary?: string;
  riskAreas?: string[];
}

export interface OutcomeLedgerEvidenceInput {
  id?: string;
  kind: string;
  title: string;
  status?: "pass" | "fail" | "pending" | "missing" | "unknown";
  url?: string;
  path?: string;
  summary?: string;
}

export interface OutcomeLedgerRiskClaimInput {
  id?: string;
  severity?: "P0" | "P1" | "P2" | "P3";
  category?: string;
  claim: string;
  evidenceIds?: string[];
  status?: "validated" | "unvalidated" | "dismissed" | "unknown";
}

export interface OutcomeLedgerProofGapInput {
  id?: string;
  severity?: "P0" | "P1" | "P2" | "P3";
  summary: string;
  owner?: string;
  requiredEvidence?: string[];
}

export interface OutcomeLedgerSafetyGateInput {
  name: string;
  status: OutcomeLedgerSafetyGateStatus;
  detail?: string;
}

export interface OutcomeLedgerReviewerDecisionInput {
  status: OutcomeLedgerDecisionStatus;
  reason?: string;
  requestedReviewer?: string;
}

export interface OutcomeLedgerRuntimeInput {
  provider?: string;
  model?: string;
  startedAt?: string;
  completedAt?: string;
  latencyMs?: number;
  providerAttempts?: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  notes?: string[];
}

export interface OutcomeLedgerPostMergeOutcomeInput {
  status: OutcomeLedgerPostMergeStatus;
  checkedAt?: string;
  summary?: string;
}

export interface OutcomeLedger {
  artifactVersion: "0.1";
  ok: boolean;
  ledgerName: string;
  runId: string;
  mode: OutcomeLedgerMode;
  generatedAt: string;
  subject: Required<Pick<OutcomeLedgerSubjectInput, "type" | "repo" | "number">> & Omit<OutcomeLedgerSubjectInput, "type" | "repo" | "number">;
  intent: Required<OutcomeLedgerIntentInput>;
  changedArtifacts: Required<OutcomeLedgerChangedArtifactInput>[];
  evidence: Array<Required<Pick<OutcomeLedgerEvidenceInput, "id" | "kind" | "title" | "status">> & OutcomeLedgerEvidenceInput>;
  riskClaims: Array<Required<Pick<OutcomeLedgerRiskClaimInput, "id" | "severity" | "category" | "claim" | "status">> & OutcomeLedgerRiskClaimInput>;
  proofGaps: Array<Required<Pick<OutcomeLedgerProofGapInput, "id" | "severity" | "summary">> & OutcomeLedgerProofGapInput>;
  safetyGates: Required<Pick<OutcomeLedgerSafetyGateInput, "name" | "status" | "detail">>[];
  reviewerDecision: Required<OutcomeLedgerReviewerDecisionInput>;
  runtime: Required<OutcomeLedgerRuntimeInput>;
  postMergeOutcome: Required<OutcomeLedgerPostMergeOutcomeInput>;
  hardGateStatus: {
    ok: boolean;
    failed: string[];
    unknown: string[];
  };
  metrics: {
    changedArtifacts: number;
    evidenceRecords: number;
    riskClaims: number;
    proofGaps: number;
    failedSafetyGates: number;
    unknownSafetyGates: number;
    latencyMs: number | null;
    providerAttempts: number | null;
    estimatedTokens: number | null;
  };
  redaction: OutcomeLedgerRedactionReport;
  proofBoundary: string;
  sha256: string;
}

export interface OutcomeLedgerRedactionReport {
  ok: boolean;
  checkedSources: number;
  redactedSources: Array<{ id: string; redactedPreview: string }>;
}

export interface OutcomeLedgerPacketResult {
  ok: boolean;
  outputDir: string;
  ledger: OutcomeLedger;
  artifacts: Record<string, string>;
}

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const DEFAULT_PROOF_BOUNDARY =
  "Outcome Ledger dry-run proves evidence-packet construction only. It does not post comments, change live runtime behavior, prove review accuracy, or claim production readiness.";

export function readOutcomeLedgerInput(path: string): OutcomeLedgerInput {
  return parseOutcomeLedgerInput(JSON.parse(readFileSync(path, "utf8")));
}

export function parseOutcomeLedgerInput(value: unknown): OutcomeLedgerInput {
  if (!isRecord(value)) throw new Error("outcome ledger input must be an object");
  const subject = value.subject;
  if (!isRecord(subject)) throw new Error("outcome ledger input requires subject");
  const input: OutcomeLedgerInput = {
    ledgerName: optionalString(value.ledgerName, "ledgerName"),
    runId: requiredString(value.runId, "runId"),
    mode: parseMode(value.mode),
    subject: {
      type: parseSubjectType(subject.type),
      repo: requiredString(subject.repo, "subject.repo"),
      number: requiredPositiveInteger(subject.number, "subject.number"),
      title: optionalString(subject.title, "subject.title"),
      url: optionalString(subject.url, "subject.url"),
      baseSha: optionalString(subject.baseSha, "subject.baseSha"),
      headSha: optionalString(subject.headSha, "subject.headSha"),
      author: optionalString(subject.author, "subject.author"),
      labels: optionalStringArray(subject.labels, "subject.labels")
    },
    intent: parseIntent(value.intent),
    changedArtifacts: optionalArray(value.changedArtifacts, "changedArtifacts").map(parseChangedArtifact),
    evidence: optionalArray(value.evidence, "evidence").map(parseEvidence),
    riskClaims: optionalArray(value.riskClaims, "riskClaims").map(parseRiskClaim),
    proofGaps: optionalArray(value.proofGaps, "proofGaps").map(parseProofGap),
    safetyGates: optionalArray(value.safetyGates, "safetyGates").map(parseSafetyGate),
    reviewerDecision: parseReviewerDecision(value.reviewerDecision),
    runtime: parseRuntime(value.runtime),
    postMergeOutcome: parsePostMergeOutcome(value.postMergeOutcome)
  };
  validateSubject(input.subject);
  return input;
}

export function buildOutcomeLedger(input: OutcomeLedgerInput, options: { now?: Date } = {}): OutcomeLedger {
  validateSubject(input.subject);
  const generatedAt = options.now?.toISOString() ?? new Date().toISOString();
  const redaction = buildRedactionReport(input);
  const safetyGates = (input.safetyGates ?? []).map((gate) => normalizeSafetyGate(gate, redaction));
  const hardGateStatus = buildHardGateStatus(safetyGates);
  const runtime = normalizeRuntime(input.runtime);
  const postMergeOutcome = normalizePostMergeOutcome(input.postMergeOutcome);
  const base = {
    artifactVersion: "0.1" as const,
    ok: redaction.ok && hardGateStatus.ok,
    ledgerName: redact(input.ledgerName ?? "outcome-ledger"),
    runId: sanitizeRunId(input.runId),
    mode: input.mode ?? "advanced_dry_run",
    generatedAt,
    subject: normalizeSubject(input.subject),
    intent: normalizeIntent(input.intent),
    changedArtifacts: (input.changedArtifacts ?? []).map(normalizeChangedArtifact),
    evidence: (input.evidence ?? []).map(normalizeEvidence),
    riskClaims: (input.riskClaims ?? []).map(normalizeRiskClaim),
    proofGaps: (input.proofGaps ?? []).map(normalizeProofGap),
    safetyGates,
    reviewerDecision: normalizeReviewerDecision(input.reviewerDecision),
    runtime,
    postMergeOutcome,
    hardGateStatus,
    metrics: {
      changedArtifacts: input.changedArtifacts?.length ?? 0,
      evidenceRecords: input.evidence?.length ?? 0,
      riskClaims: input.riskClaims?.length ?? 0,
      proofGaps: input.proofGaps?.length ?? 0,
      failedSafetyGates: hardGateStatus.failed.length,
      unknownSafetyGates: hardGateStatus.unknown.length,
      latencyMs: runtime.latencyMs >= 0 ? runtime.latencyMs : null,
      providerAttempts: runtime.providerAttempts >= 0 ? runtime.providerAttempts : null,
      estimatedTokens: runtime.totalTokens >= 0 ? runtime.totalTokens : null
    },
    redaction,
    proofBoundary: DEFAULT_PROOF_BOUNDARY
  };
  return {
    ...base,
    sha256: sha256Json(base)
  };
}

export function buildOutcomeLedgerInputFromReviewPlan(input: {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  plan: ReviewPlan;
  dryRun: boolean;
  runId?: string;
  mode?: OutcomeLedgerMode;
  runtime?: OutcomeLedgerRuntimeInput;
}): OutcomeLedgerInput {
  const sourceIssue = extractFirstRelatedIssue(`${input.pull.title}\n${input.pull.body ?? ""}`);
  return {
    ledgerName: "review-plan-outcome-ledger",
    runId: input.runId ?? `${input.repo.replaceAll("/", "__")}-pr-${input.pull.number}-${input.pull.head.sha.slice(0, 12)}`,
    mode: input.mode ?? "advanced_dry_run",
    subject: {
      type: "pull_request",
      repo: input.repo,
      number: input.pull.number,
      title: input.pull.title,
      url: input.pull.html_url,
      baseSha: input.pull.base.sha,
      headSha: input.pull.head.sha,
      labels: input.pull.labels?.map((label) => label.name) ?? []
    },
    intent: {
      summary: input.pull.body?.trim() || input.pull.title,
      ...(sourceIssue ? { sourceIssue } : {}),
      acceptanceCriteria: inferAcceptanceCriteria(input.pull.body ?? ""),
      nonGoals: []
    },
    changedArtifacts: input.files.map((file) => ({
      path: file.filename,
      changeType: normalizePullFileStatus(file.status),
      summary: `${file.changes ?? 0} changed line(s)`,
      riskAreas: input.plan.validation?.recommendations
        .filter((recommendation) => recommendation.matchedPaths.includes(file.filename))
        .map((recommendation) => recommendation.title) ?? []
    })),
    evidence: buildPlanEvidence(input.plan),
    riskClaims: input.plan.comments.map((comment, index) => ({
      id: `finding-${index + 1}`,
      severity: comment.severity,
      category: comment.category,
      claim: `${comment.title}: ${comment.body}`,
      evidenceIds: [],
      status: "validated"
    })),
    proofGaps: buildProofGaps(input.plan),
    safetyGates: [
      {
        name: "current_head",
        status: "pass",
        detail: "Worker reached review-plan construction after stale-head preflight."
      },
      {
        name: "duplicate_same_head",
        status: input.dryRun ? "pass" : "unknown",
        detail: input.dryRun ? "Dry-run ledger does not post public comments." : "Live duplicate state is outside this dry-run ledger."
      },
      {
        name: "inline_coordinate_validation",
        status: "pass",
        detail: `${input.plan.comments.length} accepted inline comment(s) survived deterministic location validation.`
      }
    ],
    reviewerDecision: {
      status: mapReviewPlanDecision(input.plan),
      reason: input.plan.summary
    },
    runtime: input.runtime,
    postMergeOutcome: {
      status: "unknown",
      summary: "Post-merge outcome is not observed at ledger creation time."
    }
  };
}

export function writeOutcomeLedgerPacket(input: {
  ledgerInput: OutcomeLedgerInput;
  outputDir: string;
  now?: Date;
}): OutcomeLedgerPacketResult {
  const ledger = buildOutcomeLedger(input.ledgerInput, { now: input.now });
  mkdirSync(input.outputDir, { recursive: true });
  const markdown = renderOutcomeLedgerMarkdown(ledger);
  const artifacts: Record<string, string> = {};
  const writeArtifact = (name: string, value: string): void => {
    const path = join(input.outputDir, name);
    writeFileSync(path, value);
    artifacts[name] = sha256File(path);
  };
  writeArtifact("outcome-ledger.json", `${JSON.stringify(ledger, null, 2)}\n`);
  writeArtifact("outcome-ledger.md", `${markdown}\n`);
  writeArtifact("redaction-report.json", `${JSON.stringify(ledger.redaction, null, 2)}\n`);
  const manifestArtifactInventory = { ...artifacts };
  writeArtifact("manifest.json", `${JSON.stringify({
    artifactVersion: "0.1",
    ok: ledger.ok,
    generatedAt: ledger.generatedAt,
    runId: ledger.runId,
    mode: ledger.mode,
    subject: ledger.subject,
    proofBoundary: ledger.proofBoundary,
    artifactInventory: manifestArtifactInventory
  }, null, 2)}\n`);
  artifacts["manifest.json"] = sha256File(join(input.outputDir, "manifest.json"));
  return {
    ok: ledger.ok,
    outputDir: input.outputDir,
    ledger,
    artifacts
  };
}

export function renderOutcomeLedgerMarkdown(ledger: OutcomeLedger): string {
  return [
    `# Outcome Ledger: ${ledger.subject.repo}#${ledger.subject.number}`,
    "",
    `- Mode: \`${ledger.mode}\``,
    `- Decision: \`${ledger.reviewerDecision.status}\``,
    `- OK: \`${ledger.ok ? "true" : "false"}\``,
    `- Head: \`${ledger.subject.headSha ?? "n/a"}\``,
    "",
    "## Intent",
    "",
    ledger.intent.summary || "No intent summary provided.",
    "",
    "## Changed Artifacts",
    "",
    ...listOrNone(ledger.changedArtifacts.map((artifact) => `- \`${artifact.path}\` (${artifact.changeType}): ${artifact.summary || "no summary"}`)),
    "",
    "## Evidence",
    "",
    ...listOrNone(ledger.evidence.map((item) => `- [${item.status}] ${item.id}: ${item.title}${item.url ? ` (${item.url})` : ""}`)),
    "",
    "## Risk Claims",
    "",
    ...listOrNone(ledger.riskClaims.map((claim) => `- [${claim.severity}/${claim.status}] ${claim.id}: ${claim.claim}`)),
    "",
    "## Proof Gaps",
    "",
    ...listOrNone(ledger.proofGaps.map((gap) => `- [${gap.severity}] ${gap.id}: ${gap.summary}`)),
    "",
    "## Safety Gates",
    "",
    ...listOrNone(ledger.safetyGates.map((gate) => `- [${gate.status}] ${gate.name}${gate.detail ? `: ${gate.detail}` : ""}`)),
    "",
    "## Runtime",
    "",
    `- Provider: ${ledger.runtime.provider || "unknown"}`,
    `- Model: ${ledger.runtime.model || "unknown"}`,
    `- Latency: ${ledger.metrics.latencyMs ?? "unknown"} ms`,
    `- Attempts: ${ledger.metrics.providerAttempts ?? "unknown"}`,
    "",
    "## Proof Boundary",
    "",
    ledger.proofBoundary
  ].join("\n");
}

function normalizeSubject(subject: OutcomeLedgerSubjectInput): OutcomeLedger["subject"] {
  return {
    type: subject.type,
    repo: redact(subject.repo),
    number: subject.number,
    ...(subject.title ? { title: redact(subject.title) } : {}),
    ...(subject.url ? { url: redact(subject.url) } : {}),
    ...(subject.baseSha ? { baseSha: redact(subject.baseSha) } : {}),
    ...(subject.headSha ? { headSha: redact(subject.headSha) } : {}),
    ...(subject.author ? { author: redact(subject.author) } : {}),
    labels: (subject.labels ?? []).map(redact).sort()
  };
}

function normalizeIntent(intent?: OutcomeLedgerIntentInput): Required<OutcomeLedgerIntentInput> {
  return {
    summary: redact(intent?.summary ?? ""),
    sourceIssue: redact(intent?.sourceIssue ?? ""),
    acceptanceCriteria: (intent?.acceptanceCriteria ?? []).map(redact),
    nonGoals: (intent?.nonGoals ?? []).map(redact)
  };
}

function normalizeChangedArtifact(artifact: OutcomeLedgerChangedArtifactInput): Required<OutcomeLedgerChangedArtifactInput> {
  return {
    path: redact(artifact.path),
    changeType: artifact.changeType ?? "unknown",
    summary: redact(artifact.summary ?? ""),
    riskAreas: (artifact.riskAreas ?? []).map(redact).sort()
  };
}

function normalizeEvidence(item: OutcomeLedgerEvidenceInput, index: number): Required<Pick<OutcomeLedgerEvidenceInput, "id" | "kind" | "title" | "status">> & OutcomeLedgerEvidenceInput {
  return {
    id: redact(item.id ?? `evidence-${index + 1}`),
    kind: redact(item.kind),
    title: redact(item.title),
    status: item.status ?? "unknown",
    ...(item.url ? { url: redact(item.url) } : {}),
    ...(item.path ? { path: redact(item.path) } : {}),
    ...(item.summary ? { summary: redact(item.summary) } : {})
  };
}

function normalizeRiskClaim(claim: OutcomeLedgerRiskClaimInput, index: number): Required<Pick<OutcomeLedgerRiskClaimInput, "id" | "severity" | "category" | "claim" | "status">> & OutcomeLedgerRiskClaimInput {
  return {
    id: redact(claim.id ?? `risk-${index + 1}`),
    severity: claim.severity ?? "P3",
    category: redact(claim.category ?? "unknown"),
    claim: redact(claim.claim),
    evidenceIds: (claim.evidenceIds ?? []).map(redact),
    status: claim.status ?? "unknown"
  };
}

function normalizeProofGap(gap: OutcomeLedgerProofGapInput, index: number): Required<Pick<OutcomeLedgerProofGapInput, "id" | "severity" | "summary">> & OutcomeLedgerProofGapInput {
  return {
    id: redact(gap.id ?? `proof-gap-${index + 1}`),
    severity: gap.severity ?? "P3",
    summary: redact(gap.summary),
    ...(gap.owner ? { owner: redact(gap.owner) } : {}),
    requiredEvidence: (gap.requiredEvidence ?? []).map(redact)
  };
}

function normalizeReviewerDecision(decision?: OutcomeLedgerReviewerDecisionInput): Required<OutcomeLedgerReviewerDecisionInput> {
  return {
    status: decision?.status ?? "unknown",
    reason: redact(decision?.reason ?? ""),
    requestedReviewer: redact(decision?.requestedReviewer ?? "")
  };
}

function normalizeRuntime(runtime?: OutcomeLedgerRuntimeInput): Required<OutcomeLedgerRuntimeInput> {
  return {
    provider: redact(runtime?.provider ?? ""),
    model: redact(runtime?.model ?? ""),
    startedAt: redact(runtime?.startedAt ?? ""),
    completedAt: redact(runtime?.completedAt ?? ""),
    latencyMs: normalizeNonNegative(runtime?.latencyMs),
    providerAttempts: normalizeNonNegative(runtime?.providerAttempts),
    promptTokens: normalizeNonNegative(runtime?.promptTokens),
    outputTokens: normalizeNonNegative(runtime?.outputTokens),
    totalTokens: normalizeNonNegative(runtime?.totalTokens),
    notes: (runtime?.notes ?? []).map(redact)
  };
}

function normalizePostMergeOutcome(outcome?: OutcomeLedgerPostMergeOutcomeInput): Required<OutcomeLedgerPostMergeOutcomeInput> {
  return {
    status: outcome?.status ?? "unknown",
    checkedAt: redact(outcome?.checkedAt ?? ""),
    summary: redact(outcome?.summary ?? "")
  };
}

function normalizeSafetyGate(
  gate: OutcomeLedgerSafetyGateInput,
  redaction: OutcomeLedgerRedactionReport
): Required<Pick<OutcomeLedgerSafetyGateInput, "name" | "status" | "detail">> {
  const name = redact(gate.name);
  if (name === "secret_redaction") {
    return {
      name,
      status: redaction.ok ? "pass" : "fail",
      detail: redaction.ok
        ? redact(gate.detail ?? "No secret-like text detected.")
        : "Secret-like text detected; see redaction report."
    };
  }
  return {
    name,
    status: gate.status,
    detail: redact(gate.detail ?? "")
  };
}

function buildHardGateStatus(safetyGates: Required<Pick<OutcomeLedgerSafetyGateInput, "name" | "status" | "detail">>[]): OutcomeLedger["hardGateStatus"] {
  const failed = safetyGates.filter((gate) => gate.status === "fail").map((gate) => gate.name);
  const unknown = safetyGates.filter((gate) => gate.status === "unknown").map((gate) => gate.name);
  return {
    ok: failed.length === 0,
    failed,
    unknown
  };
}

function buildRedactionReport(input: OutcomeLedgerInput): OutcomeLedgerRedactionReport {
  const sources = collectStringSources(input);
  const redactedSources = sources
    .filter((source) => containsSecretLikeText(source.text))
    .map((source) => ({
      id: source.id,
      redactedPreview: redactSecrets(source.text).slice(0, 240)
    }));
  return {
    ok: redactedSources.length === 0,
    checkedSources: sources.length,
    redactedSources
  };
}

function collectStringSources(input: unknown, prefix = "input"): Array<{ id: string; text: string }> {
  if (typeof input === "string") return [{ id: prefix, text: input }];
  if (Array.isArray(input)) {
    return input.flatMap((item, index) => collectStringSources(item, `${prefix}[${index}]`));
  }
  if (isRecord(input)) {
    return Object.entries(input).flatMap(([key, value]) => collectStringSources(value, `${prefix}.${key}`));
  }
  return [];
}

function parseIntent(value: unknown): OutcomeLedgerIntentInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("intent must be an object");
  return {
    summary: optionalString(value.summary, "intent.summary"),
    sourceIssue: optionalString(value.sourceIssue, "intent.sourceIssue"),
    acceptanceCriteria: optionalStringArray(value.acceptanceCriteria, "intent.acceptanceCriteria"),
    nonGoals: optionalStringArray(value.nonGoals, "intent.nonGoals")
  };
}

function parseChangedArtifact(value: unknown): OutcomeLedgerChangedArtifactInput {
  if (!isRecord(value)) throw new Error("changedArtifacts entries must be objects");
  return {
    path: requiredString(value.path, "changedArtifacts.path"),
    changeType: parseChangeType(value.changeType),
    summary: optionalString(value.summary, "changedArtifacts.summary"),
    riskAreas: optionalStringArray(value.riskAreas, "changedArtifacts.riskAreas")
  };
}

function parseEvidence(value: unknown): OutcomeLedgerEvidenceInput {
  if (!isRecord(value)) throw new Error("evidence entries must be objects");
  return {
    id: optionalString(value.id, "evidence.id"),
    kind: requiredString(value.kind, "evidence.kind"),
    title: requiredString(value.title, "evidence.title"),
    status: parseEvidenceStatus(value.status),
    url: optionalString(value.url, "evidence.url"),
    path: optionalString(value.path, "evidence.path"),
    summary: optionalString(value.summary, "evidence.summary")
  };
}

function parseRiskClaim(value: unknown): OutcomeLedgerRiskClaimInput {
  if (!isRecord(value)) throw new Error("riskClaims entries must be objects");
  return {
    id: optionalString(value.id, "riskClaims.id"),
    severity: parseSeverity(value.severity),
    category: optionalString(value.category, "riskClaims.category"),
    claim: requiredString(value.claim, "riskClaims.claim"),
    evidenceIds: optionalStringArray(value.evidenceIds, "riskClaims.evidenceIds"),
    status: parseRiskStatus(value.status)
  };
}

function parseProofGap(value: unknown): OutcomeLedgerProofGapInput {
  if (!isRecord(value)) throw new Error("proofGaps entries must be objects");
  return {
    id: optionalString(value.id, "proofGaps.id"),
    severity: parseSeverity(value.severity),
    summary: requiredString(value.summary, "proofGaps.summary"),
    owner: optionalString(value.owner, "proofGaps.owner"),
    requiredEvidence: optionalStringArray(value.requiredEvidence, "proofGaps.requiredEvidence")
  };
}

function parseSafetyGate(value: unknown): OutcomeLedgerSafetyGateInput {
  if (!isRecord(value)) throw new Error("safetyGates entries must be objects");
  return {
    name: requiredString(value.name, "safetyGates.name"),
    status: parseSafetyGateStatus(value.status),
    detail: optionalString(value.detail, "safetyGates.detail")
  };
}

function parseReviewerDecision(value: unknown): OutcomeLedgerReviewerDecisionInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("reviewerDecision must be an object");
  return {
    status: parseDecisionStatus(value.status),
    reason: optionalString(value.reason, "reviewerDecision.reason"),
    requestedReviewer: optionalString(value.requestedReviewer, "reviewerDecision.requestedReviewer")
  };
}

function parseRuntime(value: unknown): OutcomeLedgerRuntimeInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("runtime must be an object");
  return {
    provider: optionalString(value.provider, "runtime.provider"),
    model: optionalString(value.model, "runtime.model"),
    startedAt: optionalString(value.startedAt, "runtime.startedAt"),
    completedAt: optionalString(value.completedAt, "runtime.completedAt"),
    latencyMs: optionalNonNegative(value.latencyMs, "runtime.latencyMs"),
    providerAttempts: optionalNonNegative(value.providerAttempts, "runtime.providerAttempts"),
    promptTokens: optionalNonNegative(value.promptTokens, "runtime.promptTokens"),
    outputTokens: optionalNonNegative(value.outputTokens, "runtime.outputTokens"),
    totalTokens: optionalNonNegative(value.totalTokens, "runtime.totalTokens"),
    notes: optionalStringArray(value.notes, "runtime.notes")
  };
}

function parsePostMergeOutcome(value: unknown): OutcomeLedgerPostMergeOutcomeInput | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("postMergeOutcome must be an object");
  return {
    status: parsePostMergeStatus(value.status),
    checkedAt: optionalString(value.checkedAt, "postMergeOutcome.checkedAt"),
    summary: optionalString(value.summary, "postMergeOutcome.summary")
  };
}

function validateSubject(subject: OutcomeLedgerSubjectInput): void {
  if (!REPO_SLUG_PATTERN.test(subject.repo)) throw new Error("subject.repo must be owner/repo");
  if (subject.type === "pull_request") {
    if (!subject.baseSha || !SHA_PATTERN.test(subject.baseSha)) throw new Error("pull_request subject requires 40-character baseSha");
    if (!subject.headSha || !SHA_PATTERN.test(subject.headSha)) throw new Error("pull_request subject requires 40-character headSha");
  }
  if (subject.type === "issue" && (subject.baseSha || subject.headSha)) {
    throw new Error("issue subject must not include baseSha or headSha");
  }
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function optionalNonNegative(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative number`);
  return Number(value);
}

function normalizeNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : -1;
}

function parseMode(value: unknown): OutcomeLedgerMode | undefined {
  if (value === undefined) return undefined;
  return parseEnum(value, ["stable", "advanced_dry_run", "advanced_pr_review", "advanced_issue_research", "advanced_full"] as const, "mode");
}

function parseSubjectType(value: unknown): OutcomeLedgerSubjectType {
  return parseEnum(value, ["pull_request", "issue"] as const, "subject.type");
}

function parseChangeType(value: unknown): OutcomeLedgerChangedArtifactInput["changeType"] {
  if (value === undefined) return undefined;
  return parseEnum(value, ["added", "modified", "removed", "renamed", "unknown"] as const, "changedArtifacts.changeType");
}

function parseEvidenceStatus(value: unknown): OutcomeLedgerEvidenceInput["status"] {
  if (value === undefined) return undefined;
  return parseEnum(value, ["pass", "fail", "pending", "missing", "unknown"] as const, "evidence.status");
}

function parseSeverity(value: unknown): "P0" | "P1" | "P2" | "P3" | undefined {
  if (value === undefined) return undefined;
  return parseEnum(value, ["P0", "P1", "P2", "P3"] as const, "severity");
}

function parseRiskStatus(value: unknown): OutcomeLedgerRiskClaimInput["status"] {
  if (value === undefined) return undefined;
  return parseEnum(value, ["validated", "unvalidated", "dismissed", "unknown"] as const, "riskClaims.status");
}

function parseSafetyGateStatus(value: unknown): OutcomeLedgerSafetyGateStatus {
  return parseEnum(value, ["pass", "fail", "not_applicable", "unknown"] as const, "safetyGates.status");
}

function parseDecisionStatus(value: unknown): OutcomeLedgerDecisionStatus {
  return parseEnum(value, ["block", "warn", "accept_with_evidence", "defer", "human_review", "unknown"] as const, "reviewerDecision.status");
}

function parsePostMergeStatus(value: unknown): OutcomeLedgerPostMergeStatus {
  return parseEnum(value, ["unknown", "not_merged", "no_incident_seen", "regression_seen", "reverted", "hotfixed"] as const, "postMergeOutcome.status");
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function sanitizeRunId(value: string): string {
  const sanitized = value.trim().replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("runId must contain at least one safe path character");
  return sanitized.slice(0, 120);
}

function redact(value: string): string {
  return redactSecrets(value);
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function listOrNone(items: string[]): string[] {
  return items.length ? items : ["- none"];
}

function buildPlanEvidence(plan: ReviewPlan): OutcomeLedgerEvidenceInput[] {
  const evidence: OutcomeLedgerEvidenceInput[] = [
    {
      id: "deterministic-gate",
      kind: "review_gate",
      title: "Deterministic review gate",
      status: "pass",
      summary: plan.deterministicGate
        ? `${plan.deterministicGate.acceptedComments} accepted, ${plan.deterministicGate.droppedFindings} dropped.`
        : "No deterministic gate summary available."
    }
  ];
  if (plan.validation) {
    evidence.push({
      id: "changed-surface-validation",
      kind: "validation",
      title: "Changed surface validation",
      status: "pass",
      summary: plan.validation.summary
    });
  }
  if (plan.proof) {
    evidence.push({
      id: "proof-requirements",
      kind: "proof",
      title: "Proof requirements",
      status: plan.proof.status === "missing" ? "missing" : plan.proof.status === "sufficient" ? "pass" : "unknown",
      summary: plan.proof.summary
    });
  }
  return evidence;
}

function buildProofGaps(plan: ReviewPlan): OutcomeLedgerProofGapInput[] {
  if (!plan.proof || plan.proof.missingRecommendationIds.length === 0) return [];
  return plan.proof.missingRecommendationIds.map((id) => ({
    id: `missing-${id}`,
    severity: "P2",
    summary: `Missing proof for recommendation ${id}.`,
    requiredEvidence: [id]
  }));
}

function mapReviewPlanDecision(plan: ReviewPlan): OutcomeLedgerDecisionStatus {
  if (plan.event === "REQUEST_CHANGES") return "block";
  if (plan.proof?.status === "missing") return "warn";
  if (plan.comments.length > 0) return "warn";
  return "accept_with_evidence";
}

function normalizePullFileStatus(status: string | undefined): OutcomeLedgerChangedArtifactInput["changeType"] {
  if (status === "added" || status === "removed" || status === "renamed" || status === "modified") return status;
  return "unknown";
}

function extractFirstRelatedIssue(text: string): string | undefined {
  const match = text.match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#(\d+)/i);
  if (!match) return undefined;
  return match[1] ? `${match[1]}#${match[2]}` : `#${match[2]}`;
}

function inferAcceptanceCriteria(body: string): string[] {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const criteria = lines
    .filter((line) => /^[-*]\s+\[[ xX]\]/.test(line) || /^[-*]\s+(acceptance|prove|verify|test)/i.test(line))
    .map((line) => line.replace(/^[-*]\s+/, "").trim());
  return criteria.slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function assertOutcomeLedgerOutputDirEmpty(outputDir: string): void {
  if (!existsSync(outputDir)) return;
  const stat = statSync(outputDir);
  if (!stat.isDirectory()) throw new Error("outputDir must be a directory when it already exists");
  if (readdirSync(outputDir).length > 0) {
    throw new Error("outputDir must be empty before writing outcome ledger evidence; choose a fresh output directory");
  }
}
