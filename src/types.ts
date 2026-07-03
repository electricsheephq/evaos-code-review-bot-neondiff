export type Severity = "P0" | "P1" | "P2" | "P3";

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";

export type RegressionCategory =
  | "data_loss"
  | "auth"
  | "ci_build"
  | "unity_scene_prefab"
  | "security_boundary"
  | "migration"
  | "api_compatibility"
  | "release_regression"
  | "flaky_test_risk"
  | "proof_gap"
  | "runtime_correctness"
  | "dependency"
  | "docs_only"
  | "unknown";

export interface Finding {
  severity: Severity;
  path: string;
  line: number;
  title: string;
  body: string;
  confidence: number;
  category?: RegressionCategory;
  why_this_matters?: string;
}

export interface DroppedFinding extends Partial<Finding> {
  reason: string;
  fingerprint?: string;
}

export interface PullFilePatch {
  filename: string;
  patch?: string | null;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  previous_filename?: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  draft: boolean;
  state?: string;
  created_at?: string | null;
  merged_at?: string | null;
  body?: string | null;
  head: {
    sha: string;
    ref: string;
    repo?: {
      full_name: string;
      clone_url?: string;
    } | null;
  };
  base: {
    sha: string;
    ref: string;
    repo: {
      full_name: string;
      clone_url?: string;
    };
  };
  html_url: string;
  requested_reviewers?: Array<{ login: string }>;
  labels?: Array<{ name: string }>;
}

export interface RepositorySummary {
  full_name: string;
  private: boolean;
  visibility?: "public" | "private" | "internal";
}

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  severity: Severity;
  category: RegressionCategory;
  title: string;
}

export interface ReviewPlan {
  event: ReviewEvent;
  comments: ReviewComment[];
  dropped: DroppedFinding[];
  summary: string;
  deterministicGate?: DeterministicReviewGateSummary;
  validation?: ChangedSurfaceValidationReport;
  proof?: ProofRequirementReport;
  walkthrough?: WalkthroughComment;
  walkthroughComment?: WalkthroughCommentPostResult;
  enrichment?: EnrichmentComment;
  enrichmentComment?: EnrichmentCommentPostResult;
}

export interface DeterministicReviewGateSummary {
  inputFindings: number;
  acceptedComments: number;
  droppedFindings: number;
  event: ReviewEvent;
  requestChangesEligible: number;
  categoryCounts: Partial<Record<RegressionCategory, number>>;
  dropReasonCounts: Record<string, number>;
}

export interface ChangedSurfaceValidationReport {
  summary: string;
  docsOnly: boolean;
  recommendations: ValidationRecommendation[];
  profileHints: {
    validationHints: string[];
    proofExpectations: string[];
  };
}

export interface ValidationRecommendation {
  id: string;
  title: string;
  status: "required" | "recommended" | "not_applicable";
  reason: string;
  matchedPaths: string[];
  proofTypes: string[];
}

export interface ProofRequirementReport {
  status: "sufficient" | "missing" | "not_applicable";
  summary: string;
  requiredRecommendationIds: string[];
  missingRecommendationIds: string[];
  detectedEvidence: string[];
}

export interface WalkthroughComment {
  marker: string;
  body: string;
  postIssueComment: boolean;
}

export type WalkthroughCommentPostResult =
  | { posted: true; action: "created" | "updated"; html_url?: string; id: number }
  | { posted: false; reason: "disabled" | "missing_app_credentials" | "upsert_failed" };

export interface EnrichmentComment {
  marker: string;
  body: string;
  postIssueComment: boolean;
}

export type EnrichmentCommentPostResult =
  | { posted: true; action: "created" | "updated"; html_url?: string; id: number }
  | { posted: false; reason: "disabled" | "dry_run" | "missing_app_credentials" | "upsert_failed"; error?: string };
