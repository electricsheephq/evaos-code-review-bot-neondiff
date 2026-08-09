import { createHash } from "node:crypto";
import { buildFindingFingerprint } from "./findings.js";
import { applyDeterministicReviewGate, type DeterministicReviewGateResult } from "./review-gate.js";
import { getBuiltInReviewLensDefinition } from "./review-lenses.js";
import { redactSecrets } from "./secrets.js";
import type { DroppedFinding, Finding, PullFilePatch } from "./types.js";

export const REVIEW_ENSEMBLE_PLAN_VERSION = "review-ensemble-plan-v0.1";
export const REVIEW_ENSEMBLE_PACKET_VERSION = "review-ensemble-packet-v0.1";

export type ReviewEnsembleMode = "shadow";
export type ReviewEnsembleLeafId = "anchor" | "state" | "boundary" | "failure";

export interface ReviewEnsembleConfig {
  enabled: boolean;
  mode: ReviewEnsembleMode;
}

export interface ReviewEnsembleSubject {
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
}

export interface ReviewEnsembleLeafPlan {
  id: ReviewEnsembleLeafId;
  required: boolean;
}

export interface ReviewEnsemblePlan {
  version: typeof REVIEW_ENSEMBLE_PLAN_VERSION;
  mode: ReviewEnsembleMode;
  leaves: ReviewEnsembleLeafPlan[];
}

export interface ReviewEnsembleLeafOutput {
  findings: Finding[];
  dropped: DroppedFinding[];
  runtime?: object;
}

export interface ReviewEnsembleLeafReceipt extends ReviewEnsembleLeafOutput {
  leafId: ReviewEnsembleLeafId;
  required: boolean;
  status: "completed" | "failed";
  subject: ReviewEnsembleSubject;
  error?: string;
}

export interface ReviewEnsembleManifestLeaf {
  id: ReviewEnsembleLeafId;
  required: boolean;
  status: "completed" | "failed";
  error?: string;
}

export interface ReviewEnsembleManifest {
  version: typeof REVIEW_ENSEMBLE_PLAN_VERSION;
  mode: ReviewEnsembleMode;
  subject: ReviewEnsembleSubject;
  startedAt: string;
  completedAt: string;
  complete: boolean;
  leaves: ReviewEnsembleManifestLeaf[];
  proofBoundary: string;
}

export interface ReviewEnsembleRun {
  manifest: ReviewEnsembleManifest;
  receipts: ReviewEnsembleLeafReceipt[];
}

export interface ReviewEnsemblePacket {
  packetVersion: typeof REVIEW_ENSEMBLE_PACKET_VERSION;
  generatedAt: string;
  subject: ReviewEnsembleSubject;
  complete: boolean;
  postingEligible: false;
  leaves: ReviewEnsembleManifestLeaf[];
  gate: DeterministicReviewGateResult;
  provenance: Record<string, ReviewEnsembleLeafId[]>;
  proofBoundary: string;
  sha256: string;
}

const CANONICAL_LEAVES: ReviewEnsembleLeafPlan[] = [
  { id: "anchor", required: true },
  { id: "state", required: true },
  { id: "boundary", required: true },
  { id: "failure", required: true }
];

const LEAF_ORDER = new Map(CANONICAL_LEAVES.map((leaf, index) => [leaf.id, index]));

export function buildReviewEnsemblePlan(config: ReviewEnsembleConfig): ReviewEnsemblePlan | undefined {
  validateReviewEnsembleConfig(config, "reviewEnsemble");
  if (!config.enabled) return undefined;
  return {
    version: REVIEW_ENSEMBLE_PLAN_VERSION,
    mode: config.mode,
    leaves: CANONICAL_LEAVES.map((leaf) => ({ ...leaf }))
  };
}

export function validateReviewEnsembleConfig(config: ReviewEnsembleConfig, label: string): void {
  if (!isRecord(config)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(config)) {
    if (!new Set(["enabled", "mode"]).has(key)) {
      throw new Error(`${label} has unknown key "${key}"; expected only enabled or mode`);
    }
  }
  if (typeof config.enabled !== "boolean") throw new Error(`${label}.enabled must be a boolean`);
  if (config.mode !== "shadow") throw new Error(`${label}.mode must be shadow`);
}

export function buildReviewEnsembleLeafPrompt(basePrompt: string, leafId: ReviewEnsembleLeafId): string {
  if (leafId === "anchor") return basePrompt;
  const guidance = getBuiltInReviewLensDefinition(leafId);
  return [
    basePrompt.trimEnd(),
    "",
    "## Additional isolated review focus",
    guidance.title,
    guidance.body,
    "Do not use tools, agents, web, MCP, shell, memory, or writes. Use only the supplied immutable review context.",
    "For each reproduced finding, include the smallest safe fix direction, a focused acceptance check, and relevant non-goals in the finding body.",
    "Return the same strict findings schema. This leaf cannot post, approve, edit, or change review policy.",
    ""
  ].join("\n");
}

export async function executeReviewEnsemble(input: {
  plan: ReviewEnsemblePlan;
  subject: ReviewEnsembleSubject;
  runLeaf: (leaf: ReviewEnsembleLeafPlan) => Promise<ReviewEnsembleLeafOutput>;
  startedAt?: string;
  completedAt?: () => string;
}): Promise<ReviewEnsembleRun> {
  const startedAt = input.startedAt ?? new Date().toISOString();
  requireIsoTimestamp(startedAt, "review ensemble startedAt");
  const settled = await Promise.allSettled(input.plan.leaves.map((leaf) => input.runLeaf(leaf)));
  const receipts = input.plan.leaves.map((leaf, index): ReviewEnsembleLeafReceipt => {
    const result = settled[index]!;
    if (result.status === "fulfilled") {
      return {
        leafId: leaf.id,
        required: leaf.required,
        status: "completed",
        subject: { ...input.subject },
        findings: result.value.findings,
        dropped: result.value.dropped,
        ...(result.value.runtime ? { runtime: result.value.runtime } : {})
      };
    }
    return {
      leafId: leaf.id,
      required: leaf.required,
      status: "failed",
      subject: { ...input.subject },
      findings: [],
      dropped: [],
      error: redactSecrets(result.reason instanceof Error ? result.reason.message : String(result.reason))
    };
  });
  const completedAt = input.completedAt?.() ?? new Date().toISOString();
  requireIsoTimestamp(completedAt, "review ensemble completedAt");
  const leaves = receipts.map(toManifestLeaf);
  return {
    manifest: {
      version: input.plan.version,
      mode: input.plan.mode,
      subject: { ...input.subject },
      startedAt,
      completedAt,
      complete: leaves.every((leaf) => !leaf.required || leaf.status === "completed"),
      leaves,
      proofBoundary: "Shadow ensemble evidence is advisory only. It cannot post, approve, edit code, write processed-head state, or change the canonical parent review result."
    },
    receipts
  };
}

export function reduceReviewEnsemble(input: {
  subject: ReviewEnsembleSubject;
  files: PullFilePatch[];
  receipts: ReviewEnsembleLeafReceipt[];
  generatedAt?: string;
  gatePolicy?: Omit<Parameters<typeof applyDeterministicReviewGate>[0], "findings" | "files" | "droppedFromSchema">;
}): ReviewEnsemblePacket {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  requireIsoTimestamp(generatedAt, "review ensemble generatedAt");
  const receipts = normalizeReceipts(input.subject, input.receipts);
  const complete = CANONICAL_LEAVES.every((expected) => {
    const receipt = receipts.find((candidate) => candidate.leafId === expected.id);
    return !expected.required || receipt?.status === "completed";
  });
  const completed = receipts.filter((receipt) => receipt.status === "completed");
  const findings = completed.flatMap((receipt) => receipt.findings);
  const dropped = completed.flatMap((receipt) => receipt.dropped);
  const gate = applyDeterministicReviewGate({
    findings,
    files: input.files,
    droppedFromSchema: dropped,
    ...input.gatePolicy
  });
  const provenance: Record<string, ReviewEnsembleLeafId[]> = {};
  for (const receipt of completed) {
    for (const item of receipt.findings) {
      const fingerprint = buildFindingFingerprint(item);
      const ids = provenance[fingerprint] ?? [];
      if (!ids.includes(receipt.leafId)) ids.push(receipt.leafId);
      provenance[fingerprint] = ids.sort(compareLeafId);
    }
  }
  const leaves = receipts.map(toManifestLeaf);
  const proofBoundary = "This packet is a non-posting shadow reduction. Only the canonical parent review may own GitHub posting, processed-head state, readiness, or review-event authority.";
  const payload: Omit<ReviewEnsemblePacket, "sha256"> = {
    packetVersion: REVIEW_ENSEMBLE_PACKET_VERSION,
    generatedAt,
    subject: input.subject,
    complete,
    postingEligible: false as const,
    leaves,
    gate,
    provenance,
    proofBoundary
  };
  return {
    ...payload,
    sha256: createHash("sha256").update(stableStringify(payload)).digest("hex")
  };
}

function normalizeReceipts(subject: ReviewEnsembleSubject, receipts: ReviewEnsembleLeafReceipt[]): ReviewEnsembleLeafReceipt[] {
  const seen = new Set<ReviewEnsembleLeafId>();
  for (const receipt of receipts) {
    if (seen.has(receipt.leafId)) throw new Error(`duplicate review ensemble leaf receipt: ${receipt.leafId}`);
    seen.add(receipt.leafId);
    if (receipt.subject.repo !== subject.repo) throw new Error(`review ensemble repo mismatch for ${receipt.leafId}`);
    if (receipt.subject.pullNumber !== subject.pullNumber) throw new Error(`review ensemble pull number mismatch for ${receipt.leafId}`);
    if (receipt.subject.baseSha !== subject.baseSha) throw new Error(`review ensemble base SHA mismatch for ${receipt.leafId}`);
    if (receipt.subject.headSha !== subject.headSha) throw new Error(`review ensemble head SHA mismatch for ${receipt.leafId}`);
  }
  return [...receipts].sort((left, right) => compareLeafId(left.leafId, right.leafId));
}

function toManifestLeaf(receipt: ReviewEnsembleLeafReceipt): ReviewEnsembleManifestLeaf {
  return {
    id: receipt.leafId,
    required: receipt.required,
    status: receipt.status,
    ...(receipt.error ? { error: redactSecrets(receipt.error) } : {})
  };
}

function compareLeafId(left: ReviewEnsembleLeafId, right: ReviewEnsembleLeafId): number {
  return (LEAF_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) - (LEAF_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER);
}

function requireIsoTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
