import type { RegressionCategory } from "./types.js";

export type ReviewMode = "fast" | "standard" | "deep" | "product_pm" | "research";

export type ReviewModeBudgetDisposition = "within_budget" | "partial" | "timeout_risk" | "deferred";

export interface ReviewModeBudget {
  targetMinutes: number;
  targetMs: number;
  hardTimeoutMinutes: number;
  hardTimeoutMs: number;
  disposition: ReviewModeBudgetDisposition;
  detail: string;
}

export interface ReviewModeSelection {
  mode: ReviewMode;
  targetUse: "pull_request_review" | "issue_enrichment";
  confidence: number;
  outcomeWeights: {
    regressionPrevention: number;
    signalToNoise: number;
    latencyFlow: number;
    contextProofAwareness: number;
    glmCostEfficiency: number;
    safetyLifecycle: number;
  };
  reasons: string[];
  matchedSignals: string[];
  riskAreas: RegressionCategory[];
  budget: ReviewModeBudget;
  proofBoundary: string;
}

export type ReviewModeContextSource = "patch" | "repo_memory" | "gitnexus" | "github_related" | "skill_packs";

export interface ReviewModeEscalationConfig {
  allowDepthEscalation: boolean;
  allowDepthEscalationWhileProviderBacklog: boolean;
  allowManualCommand: boolean;
  allowRequestChanges: boolean;
}

export interface ReviewModeRuntimeConfig {
  targetMinutes: number;
  wholeRunDeadlineMs: number;
  perAttemptTimeoutMs: number;
  maxPatchBytes: number;
  maxContextBytes: number;
  maxProviderAttempts: number;
  allowedContextSources: ReviewModeContextSource[];
  queueWeight: number;
  leaseTtlMs: number;
  heartbeatMs: number;
  escalation: ReviewModeEscalationConfig;
}

export interface ReviewModesConfig {
  enabled: boolean;
  defaultMode: Exclude<ReviewMode, "research">;
  modes: Record<ReviewMode, ReviewModeRuntimeConfig>;
}
