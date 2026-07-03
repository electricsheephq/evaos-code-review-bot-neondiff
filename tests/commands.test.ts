import { describe, expect, it } from "vitest";
import {
  collectTrustedReviewCommands,
  decideCommandAction,
  isRecordOnlyCommandAction,
  parseReviewCommand
} from "../src/commands.js";

describe("maintainer command parsing", () => {
  const config = {
    enabled: true,
    botMentions: ["@evaos-code-review-bot"],
    trustedAuthors: ["100yenadmin", "coderabbitai"],
    acknowledge: false
  };

  it("parses exact review, re-review, explain, and stop commands", () => {
    expect(parseReviewCommand(comment(101, "100yenadmin", "@evaos-code-review-bot review"), config)).toMatchObject({
      action: "review",
      commentId: 101,
      author: "100yenadmin"
    });
    expect(parseReviewCommand(comment(102, "100yenadmin", "@evaos-code-review-bot re-review"), config)).toMatchObject({
      action: "re-review"
    });
    expect(parseReviewCommand(comment(103, "100yenadmin", "@evaos-code-review-bot explain"), config)).toMatchObject({
      action: "explain"
    });
    expect(parseReviewCommand(comment(104, "100yenadmin", "@evaos-code-review-bot stop"), config)).toMatchObject({
      action: "stop"
    });
    expect(parseReviewCommand(comment(105, "100yenadmin", "@evaos-code-review-bot generate tests"), config)).toMatchObject({
      action: "generate_tests"
    });
    expect(parseReviewCommand(comment(106, "100yenadmin", "@evaos-code-review-bot explain risk"), config)).toMatchObject({
      action: "explain_risk"
    });
  });

  it("ignores disabled, malformed, and untrusted commands", () => {
    expect(parseReviewCommand(comment(101, "100yenadmin", "@evaos-code-review-bot review"), { ...config, enabled: false })).toBeUndefined();
    expect(parseReviewCommand(comment(102, "100yenadmin", "@evaos-code-review-bot repair"), config)).toBeUndefined();
    expect(parseReviewCommand(comment(103, "drive-by", "@evaos-code-review-bot review"), config)).toBeUndefined();
  });

  it("collects trusted commands and reports unauthorized attempts without executing them", () => {
    const collected = collectTrustedReviewCommands(
      [
        comment(101, "drive-by", "@evaos-code-review-bot review"),
        comment(102, "100yenadmin", "@evaos-code-review-bot explain"),
        comment(103, "coderabbitai", "@evaos-code-review-bot re-review")
      ],
      config
    );

    expect(collected.commands.map((command) => command.commentId)).toEqual([102, 103]);
    expect(collected.unauthorized.map((entry) => entry.commentId)).toEqual([101]);
  });

  it("uses the latest unprocessed command for the current head", () => {
    const collected = collectTrustedReviewCommands(
      [
        comment(101, "100yenadmin", "@evaos-code-review-bot review"),
        comment(102, "100yenadmin", "@evaos-code-review-bot stop")
      ],
      config
    );

    expect(decideCommandAction({
      commands: collected.commands,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-1",
      hasProcessedCommand: () => false
    })).toMatchObject({
      action: "stop",
      commandId: 102,
      shouldReview: false
    });
  });

  it("routes review commands into the safe review pipeline", () => {
    const collected = collectTrustedReviewCommands(
      [comment(101, "100yenadmin", "@evaos-code-review-bot review")],
      config
    );

    expect(decideCommandAction({
      commands: collected.commands,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-1",
      hasProcessedCommand: () => false
    })).toMatchObject({
      action: "review",
      commandId: 101,
      shouldReview: true
    });
  });

  it("keeps finishing-touch commands record-only", () => {
    const collected = collectTrustedReviewCommands(
      [comment(101, "100yenadmin", "@evaos-code-review-bot generate tests")],
      config
    );

    const decision = decideCommandAction({
      commands: collected.commands,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-1",
      hasProcessedCommand: () => false
    });

    expect(decision).toMatchObject({
      action: "generate_tests",
      commandId: 101,
      shouldReview: false
    });
    expect(isRecordOnlyCommandAction("generate_tests")).toBe(true);
    expect(isRecordOnlyCommandAction("re-review")).toBe(false);
  });

  it("does not let draft-only commands supersede an outstanding review request", () => {
    const collected = collectTrustedReviewCommands(
      [
        comment(101, "100yenadmin", "@evaos-code-review-bot review"),
        comment(102, "100yenadmin", "@evaos-code-review-bot generate tests")
      ],
      config
    );

    expect(decideCommandAction({
      commands: collected.commands,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-1",
      hasProcessedCommand: () => false
    })).toMatchObject({
      action: "review",
      commandId: 101,
      shouldReview: true
    });
  });

  it("does not let a later draft-only command supersede an outstanding stop command", () => {
    const collected = collectTrustedReviewCommands(
      [
        comment(101, "100yenadmin", "@evaos-code-review-bot stop"),
        comment(102, "100yenadmin", "@evaos-code-review-bot generate tests")
      ],
      config
    );

    expect(decideCommandAction({
      commands: collected.commands,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-1",
      hasProcessedCommand: () => false
    })).toMatchObject({
      action: "stop",
      commandId: 101,
      shouldReview: false
    });
  });

  it("dedupes already processed command comments for the same head", () => {
    const collected = collectTrustedReviewCommands(
      [comment(101, "100yenadmin", "@evaos-code-review-bot review")],
      config
    );

    expect(decideCommandAction({
      commands: collected.commands,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-1",
      hasProcessedCommand: (_repo, _pull, _head, commentId) => commentId === 101
    })).toEqual({ action: "none", shouldReview: false });
  });
});

function comment(id: number, login: string, body: string) {
  return {
    id,
    body,
    html_url: `https://github.test/comment/${id}`,
    user: {
      login,
      type: login.endsWith("ai") ? "Bot" : "User"
    }
  };
}
