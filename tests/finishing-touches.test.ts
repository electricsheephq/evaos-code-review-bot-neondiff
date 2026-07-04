import { describe, expect, it } from "vitest";
import {
  buildFinishingTouchDryRunContract,
  buildFinishingTouchDraft,
  parseFinishingTouchCommand,
  validateFinishingTouchRequest
} from "../src/finishing-touches.js";

describe("finishing-touch draft commands", () => {
  it("parses trusted bot-mentioned finishing-touch commands", () => {
    expect(parseFinishingTouchCommand({
      body: "@evaos-code-review-bot generate tests",
      botMentions: ["@evaos-code-review-bot"]
    })).toMatchObject({ action: "generate_tests" });
    expect(parseFinishingTouchCommand({
      body: "Looks good\n@evaos-code-review-bot changelog draft",
      botMentions: ["@evaos-code-review-bot"]
    })).toMatchObject({ action: "changelog_draft" });
    expect(parseFinishingTouchCommand({
      body: "@evaos-code-review-bot generate tests please.",
      botMentions: ["@evaos-code-review-bot"]
    })).toMatchObject({ action: "generate_tests" });
    expect(parseFinishingTouchCommand({
      body: "@evaos-code-review-bot explain risk!",
      botMentions: ["@evaos-code-review-bot"]
    })).toMatchObject({ action: "explain_risk" });
    expect(parseFinishingTouchCommand({
      body: "@coderabbitai generate tests",
      botMentions: ["@evaos-code-review-bot"]
    })).toBeUndefined();
    expect(parseFinishingTouchCommand({
      body: "@evaos-code-review-bot generate tests and push it",
      botMentions: ["@evaos-code-review-bot"]
    })).toBeUndefined();
    for (const bareCommand of ["unit tests", "docstrings", "simplify", "simplify this"]) {
      expect(parseFinishingTouchCommand({
        body: `@evaos-code-review-bot ${bareCommand}`,
        botMentions: ["@evaos-code-review-bot"]
      })).toBeUndefined();
    }
  });

  it("fails closed for untrusted authors, stale heads, dirty worktrees, and secret-like output", () => {
    const base = {
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      currentHeadSha: "head-a",
      commentId: 123,
      author: "100yenadmin",
      trustedAuthors: ["100yenadmin"],
      worktreeClean: true,
      action: "generate_tests" as const
    };

    expect(validateFinishingTouchRequest(base)).toEqual({ ok: true });
    expect(validateFinishingTouchRequest({ ...base, author: "stranger" })).toMatchObject({
      ok: false,
      reason: "untrusted_author"
    });
    expect(validateFinishingTouchRequest({ ...base, currentHeadSha: "head-b" })).toMatchObject({
      ok: false,
      reason: "stale_head"
    });
    expect(validateFinishingTouchRequest({ ...base, worktreeClean: false })).toMatchObject({
      ok: false,
      reason: "dirty_worktree"
    });
    expect(validateFinishingTouchRequest({
      ...base,
      proposedOutput: "token ghp_123456789012345678901234567890123456"
    })).toMatchObject({
      ok: false,
      reason: "secret_detected"
    });
  });

  it("builds draft-only proposal output without enabling mutation", () => {
    const draft = buildFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      action: "explain_risk",
      author: "100yenadmin",
      commentId: 456,
      trigger: "@evaos-code-review-bot explain risk",
      generatedAt: "2026-07-03T00:00:00.000Z"
    });

    expect(draft).toMatchObject({
      mode: "draft_only",
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      action: "explain_risk",
      author: "100yenadmin",
      commandCommentId: 456,
      canPush: false,
      canCommit: false,
      canApprove: false
    });
    expect(draft.markdown).toContain("Draft only");
    expect(draft.markdown).toContain("No branch was pushed");
  });

  it("renders a dry-run contract with explicit default-off mutation guards", () => {
    const draft = buildFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      action: "changelog_draft",
      author: "100yenadmin",
      commentId: 789,
      trigger: "@evaos-code-review-bot changelog draft",
      generatedAt: "2026-07-03T00:00:00.000Z"
    });

    const contract = buildFinishingTouchDryRunContract({
      dryRun: true,
      recorded: false,
      draft,
      currentHeadSha: "head-a",
      worktreeClean: true,
      trustedAuthors: ["100yenadmin"],
      validation: { ok: true }
    });

    expect(contract).toMatchObject({
      ok: true,
      mode: "draft_only",
      defaultOff: true,
      dryRun: true,
      recorded: false,
      target: {
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 157,
        headSha: "head-a",
        currentHeadSha: "head-a",
        staleHead: false
      },
      command: {
        action: "changelog_draft",
        author: "100yenadmin",
        commentId: 789
      },
      safety: {
        trustedAuthor: true,
        currentHeadMatches: true,
        worktreeClean: true,
        secretScan: "passed",
        mutation: {
          canPush: false,
          canCommit: false,
          canApprove: false,
          directProtectedBranchCommit: false
        }
      }
    });
    expect(contract.draft).toBe(draft);
  });
});
