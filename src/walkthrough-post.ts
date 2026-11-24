import { join } from "node:path";
import { appendLcmReviewAssessment } from "./lcm-review-assessment.js";
import { isLcmReviewRepository } from "./lcm-review-repository.js";
import type { PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { redactSecrets } from "./secrets.js";
import { writeSecureFileSync } from "./temp-files.js";
import type { OutsideDiffFinding, ReviewPlan, WalkthroughComment, WalkthroughCommentPostResult } from "./types.js";
import { formatOutsideDiffFindings, truncateReviewText } from "./walkthrough.js";

export interface WalkthroughCommentGithub {
  canPost(): boolean;
  upsertIssueComment(input: {
    repo: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<{ action: "created" | "updated"; html_url?: string; id: number }>;
}

export async function postWalkthroughComment(input: {
  github: WalkthroughCommentGithub;
  repo: string;
  pullNumber: number;
  evidenceDir: string;
  walkthrough?: WalkthroughComment;
}): Promise<WalkthroughCommentPostResult> {
  if (!input.walkthrough?.postIssueComment) return { posted: false, reason: "disabled" };
  if (!input.github.canPost()) return { posted: false, reason: "missing_app_credentials" };

  try {
    const comment = await input.github.upsertIssueComment({
      repo: input.repo,
      issueNumber: input.pullNumber,
      marker: input.walkthrough.marker,
      body: input.walkthrough.body
    });
    writeSecureFileSync(join(input.evidenceDir, "walkthrough-comment.json"), `${redactSecrets(JSON.stringify(comment, null, 2))}\n`);
    return { posted: true, ...comment };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeSecureFileSync(join(input.evidenceDir, "walkthrough-comment-error.txt"), `${redactSecrets(message)}\n`);
    return { posted: false, reason: "upsert_failed" };
  }
}

export function reviewBodyAfterWalkthroughPost(plan: Pick<ReviewPlan, "summary" | "walkthrough" | "walkthroughComment">): string {
  if (!plan.walkthrough) return plan.summary;
  if (!plan.walkthrough.postIssueComment) return plan.walkthrough.body;
  if (!plan.walkthroughComment?.posted) return plan.walkthrough.body;
  return plan.summary;
}

export function buildReviewBodyForPost(input: {
  repo: string;
  model: string;
  outsideDiffFindings: OutsideDiffFinding[];
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
  assessment?: string;
  initialBody?: string;
  render: (lines: string[]) => string;
}): { body: string; publishedOutsideDiffFindings: OutsideDiffFinding[] } {
  const compose = (body: string) => {
    const assessed = appendLcmReviewAssessment(body, input.assessment, input.repo);
    return isLcmReviewRepository(input.repo) ? assessed : appendReviewAttribution(assessed, input.model);
  };
  const format = (detail: "full" | "titles" | "paths" | "count", budget?: number) =>
    formatOutsideDiffFindings(input.outsideDiffFindings, input.publicConfidencePolicy, detail, budget);
  let section = format("full");
  let body = compose(input.initialBody ?? input.render(section.lines));
  if (input.assessment && input.outsideDiffFindings.length && !body.endsWith(input.assessment)) {
    for (const detail of ["titles", "count", "omit"] as const) {
      const compact = detail === "omit" ? { lines: [], listedCount: 0 } : format(detail);
      const candidate = compose(input.render(compact.lines));
      if (!candidate.endsWith(input.assessment)) continue;
      section = compact;
      body = candidate;
      break;
    }
  }
  const limit = 60_000;
  if (body.length > limit) {
    const base = compose(input.render([]));
    section = format("paths", Math.max(0, limit - base.length - 2));
    body = compose(input.render(section.lines));
    if (body.length > limit) {
      section = { lines: [], listedCount: 0 };
      body = truncateReviewText(base, limit);
    }
  }
  return { body, publishedOutsideDiffFindings: input.outsideDiffFindings.slice(0, section.listedCount) };
}

export const REVIEW_ATTRIBUTION_PREFIX = "Reviewed by [NeonDiff](https://www.neondiff.com/?utm_source=github&utm_medium=review&utm_campaign=footer) · ";

export function appendReviewAttribution(body: string, model: string): string {
  const footer = `${REVIEW_ATTRIBUTION_PREFIX}${model}`;
  return `${body.split("\n").filter((line) => line !== footer).join("\n").trimEnd()}\n\n${footer}`;
}
