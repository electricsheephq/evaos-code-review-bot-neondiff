export type Severity = "P0" | "P1" | "P2" | "P3";

export type ReviewEvent = "COMMENT" | "REQUEST_CHANGES";

export interface Finding {
  severity: Severity;
  path: string;
  line: number;
  title: string;
  body: string;
  confidence: number;
  why_this_matters?: string;
}

export interface DroppedFinding extends Partial<Finding> {
  reason: string;
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

export interface ReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  severity: Severity;
  title: string;
}

export interface ReviewPlan {
  event: ReviewEvent;
  comments: ReviewComment[];
  dropped: DroppedFinding[];
  summary: string;
  walkthrough?: WalkthroughComment;
  walkthroughComment?: WalkthroughCommentPostResult;
}

export interface WalkthroughComment {
  marker: string;
  body: string;
  postIssueComment: boolean;
}

export type WalkthroughCommentPostResult =
  | { posted: true; action: "created" | "updated"; html_url?: string; id: number }
  | { posted: false; reason: "disabled" | "missing_app_credentials" | "upsert_failed" };
