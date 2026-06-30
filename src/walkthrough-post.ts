import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secrets.js";
import type { WalkthroughComment } from "./types.js";

export interface WalkthroughCommentGithub {
  canPostAsApp(): boolean;
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
}): Promise<
  | { posted: true; action: "created" | "updated"; html_url?: string; id: number }
  | { posted: false; reason: "disabled" | "missing_app_credentials" | "upsert_failed" }
> {
  if (!input.walkthrough?.postIssueComment) return { posted: false, reason: "disabled" };
  if (!input.github.canPostAsApp()) return { posted: false, reason: "missing_app_credentials" };

  try {
    const comment = await input.github.upsertIssueComment({
      repo: input.repo,
      issueNumber: input.pullNumber,
      marker: input.walkthrough.marker,
      body: input.walkthrough.body
    });
    writeFileSync(join(input.evidenceDir, "walkthrough-comment.json"), `${JSON.stringify(comment, null, 2)}\n`);
    return { posted: true, ...comment };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(join(input.evidenceDir, "walkthrough-comment-error.txt"), redactSecrets(message));
    return { posted: false, reason: "upsert_failed" };
  }
}
