import { describe, expect, it } from "vitest";
import {
  buildFinishingTouchDryRunContract,
  buildFinishingTouchDraft,
  parseFinishingTouchCommand,
  validateFinishingTouchRequest
} from "../src/finishing-touches.js";

describe("finishing-touch draft commands", () => {
  const fullHeadSha = "0123456789abcdef0123456789abcdef01234567";
  const otherFullHeadSha = "89abcdef0123456789abcdef0123456789abcdef";

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
      body: "@neondiff draft tests",
      botMentions: ["@neondiff"]
    })).toMatchObject({ action: "generate_tests", phrase: "draft tests" });
    expect(parseFinishingTouchCommand({
      body: "@neondiff draft docs",
      botMentions: ["@neondiff"]
    })).toMatchObject({ action: "generate_docs", phrase: "draft docs" });
    expect(parseFinishingTouchCommand({
      body: "@neondiff draft changelog",
      botMentions: ["@neondiff"]
    })).toMatchObject({ action: "changelog_draft", phrase: "draft changelog" });
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
      headSha: fullHeadSha,
      currentHeadSha: fullHeadSha,
      commentId: 123,
      author: "100yenadmin",
      trustedAuthors: ["100yenadmin"],
      worktreeClean: true,
      action: "generate_tests" as const
    };

    expect(validateFinishingTouchRequest(base)).toEqual({ ok: true, secretScan: "not_scanned" });
    expect(validateFinishingTouchRequest({
      ...base,
      proposedOutput: "Draft output with no credential material."
    })).toEqual({ ok: true, secretScan: "passed" });
    expect(validateFinishingTouchRequest({ ...base, author: "stranger" })).toMatchObject({
      ok: false,
      reason: "untrusted_author",
      secretScan: "not_scanned"
    });
    expect(validateFinishingTouchRequest({ ...base, currentHeadSha: otherFullHeadSha })).toMatchObject({
      ok: false,
      reason: "stale_head",
      secretScan: "not_scanned"
    });
    expect(validateFinishingTouchRequest({ ...base, worktreeClean: false })).toMatchObject({
      ok: false,
      reason: "dirty_worktree",
      secretScan: "not_scanned"
    });
    expect(validateFinishingTouchRequest({
      ...base,
      proposedOutput: "token ghp_123456789012345678901234567890123456"
    })).toMatchObject({
      ok: false,
      reason: "secret_detected",
      secretScan: "failed"
    });
  });

  it("requires explicit full target and current head SHAs before generation can pass", () => {
    const base = {
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: fullHeadSha,
      currentHeadSha: fullHeadSha,
      commentId: 123,
      author: "100yenadmin",
      trustedAuthors: ["100yenadmin"],
      worktreeClean: true,
      action: "generate_tests" as const
    };

    for (const input of [
      { ...base, headSha: "" },
      { ...base, headSha: "HEAD" },
      { ...base, headSha: "0123456" },
      { ...base, currentHeadSha: undefined },
      { ...base, currentHeadSha: "" },
      { ...base, currentHeadSha: "HEAD" },
      { ...base, currentHeadSha: "0123456" }
    ]) {
      expect(validateFinishingTouchRequest(input), JSON.stringify(input)).toMatchObject({
        ok: false,
        reason: "missing_explicit_head_sha",
        secretScan: "not_scanned"
      });
    }
  });

  it("builds draft-only proposal output without enabling mutation", () => {
    const draft = buildFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: fullHeadSha,
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
      headSha: fullHeadSha,
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
      headSha: fullHeadSha,
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
      currentHeadSha: fullHeadSha,
      worktreeClean: true,
      trustedAuthors: ["100yenadmin"],
      validation: { ok: true, secretScan: "passed" }
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
        headSha: fullHeadSha,
        currentHeadSha: fullHeadSha,
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
        worktreeClean: "verified_clean",
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

  it("treats missing current head evidence as stale instead of a match", () => {
    const draft = buildFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: fullHeadSha,
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
      currentHeadSha: "",
      worktreeClean: true,
      trustedAuthors: ["100yenadmin"],
      validation: { ok: true, secretScan: "not_scanned" }
    });

    expect(contract).toMatchObject({
      ok: true,
      target: {
        currentHeadSha: "",
        staleHead: true
      },
      safety: {
        currentHeadMatches: false,
        secretScan: "not_scanned"
      }
    });
  });

  it("treats placeholder head values as stale instead of current-head evidence", () => {
    const draft = buildFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "HEAD",
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
      currentHeadSha: "HEAD",
      worktreeClean: true,
      trustedAuthors: ["100yenadmin"],
      validation: { ok: true, secretScan: "not_scanned" }
    });

    expect(contract).toMatchObject({
      target: {
        currentHeadSha: "HEAD",
        staleHead: true
      },
      safety: {
        currentHeadMatches: false
      }
    });
  });

  it("renders validation failures without drafts, skipped scan claims, or raw triggers", () => {
    const baseDraft = buildFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: fullHeadSha,
      action: "generate_tests",
      author: "100yenadmin",
      commentId: 789,
      trigger: "@evaos-code-review-bot generate tests ghp_123456789012345678901234567890123456",
      generatedAt: "2026-07-03T00:00:00.000Z"
    });
    const failureCases = [
      {
        name: "untrusted_author",
        validation: {
          ok: false,
          reason: "untrusted_author",
          detail: "Author stranger is not trusted.",
          secretScan: "not_scanned"
        } as const,
        trustedAuthors: ["maintainer"],
        currentHeadSha: fullHeadSha,
        worktreeClean: true,
        expectedSafety: {
          trustedAuthor: false,
          currentHeadMatches: true,
          worktreeClean: "verified_clean",
          secretScan: "not_scanned"
        }
      },
      {
        name: "stale_head",
        validation: {
          ok: false,
          reason: "stale_head",
          detail: `Command targeted ${fullHeadSha}, but current head is ${otherFullHeadSha}.`,
          secretScan: "not_scanned"
        } as const,
        trustedAuthors: ["100yenadmin"],
        currentHeadSha: otherFullHeadSha,
        worktreeClean: true,
        expectedSafety: {
          trustedAuthor: true,
          currentHeadMatches: false,
          worktreeClean: "verified_clean",
          secretScan: "not_scanned"
        }
      },
      {
        name: "dirty_worktree",
        validation: {
          ok: false,
          reason: "dirty_worktree",
          detail: "Refusing finishing-touch draft while the worktree is dirty.",
          secretScan: "not_scanned"
        } as const,
        trustedAuthors: ["100yenadmin"],
        currentHeadSha: fullHeadSha,
        worktreeClean: false,
        expectedSafety: {
          trustedAuthor: true,
          currentHeadMatches: true,
          worktreeClean: "dirty",
          secretScan: "not_scanned"
        }
      },
      {
        name: "secret_detected",
        validation: {
          ok: false,
          reason: "secret_detected",
          detail: "Refusing finishing-touch draft because proposed output contains secret-like text.",
          secretScan: "failed"
        } as const,
        trustedAuthors: ["100yenadmin"],
        currentHeadSha: fullHeadSha,
        worktreeClean: true,
        expectedSafety: {
          trustedAuthor: true,
          currentHeadMatches: true,
          worktreeClean: "verified_clean",
          secretScan: "failed"
        }
      }
    ];

    for (const failureCase of failureCases) {
      const contract = buildFinishingTouchDryRunContract({
        dryRun: true,
        recorded: false,
        draft: {
          ...baseDraft,
          author: failureCase.name === "untrusted_author" ? "stranger" : baseDraft.author
        },
        currentHeadSha: failureCase.currentHeadSha,
        worktreeClean: failureCase.worktreeClean,
        trustedAuthors: failureCase.trustedAuthors,
        validation: failureCase.validation
      });

      expect(contract, failureCase.name).toMatchObject({
        ok: false,
        target: {
          staleHead: failureCase.name === "stale_head"
        },
        safety: failureCase.expectedSafety,
        validation: failureCase.validation
      });
      expect(contract, failureCase.name).not.toHaveProperty("draft");
      expect(contract, failureCase.name).not.toHaveProperty("command.trigger");
      expect(JSON.stringify(contract), failureCase.name).not.toContain("ghp_123456789012345678901234567890123456");
    }
  });
});
