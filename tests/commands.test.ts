import { describe, expect, it } from "vitest";
import {
  classifyCommandAuthorization,
  collectReviewEventAuthorizationAttempts,
  collectTrustedReviewCommands,
  decideCommandAction,
  isBotCommandComment,
  isRecordOnlyCommandAction,
  parseReviewCommand
} from "../src/commands.js";
import { loadConfigFromObject } from "../src/config.js";

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

describe("public command authorization classification (#345)", () => {
  const trusted = { enabled: true, botMentions: ["@bot"], trustedAuthors: ["100yenadmin"], acknowledge: false };
  const withPublic = { ...trusted, publicCommands: { enabled: true, actions: ["review", "re-review"] as Array<"review" | "re-review">, cooldownMinutes: 10 } };

  it("classifies a trusted author as trusted for every action", () => {
    for (const action of ["review", "re-review", "explain", "stop"] as const) {
      expect(classifyCommandAuthorization({ action, author: "100yenadmin" }, trusted)).toBe("trusted");
      expect(classifyCommandAuthorization({ action, author: "100yenadmin" }, withPublic)).toBe("trusted");
    }
  });

  it("classifies a non-trusted author as unauthorized when publicCommands is absent/disabled (byte-identical)", () => {
    expect(classifyCommandAuthorization({ action: "review", author: "randopublic" }, trusted)).toBe("unauthorized");
    const disabled = { ...trusted, publicCommands: { enabled: false, actions: ["review"] as Array<"review" | "re-review">, cooldownMinutes: 10 } };
    expect(classifyCommandAuthorization({ action: "review", author: "randopublic" }, disabled)).toBe("unauthorized");
  });

  it("classifies a non-trusted author as public-eligible only for review/re-review when enabled", () => {
    expect(classifyCommandAuthorization({ action: "review", author: "randopublic" }, withPublic)).toBe("public-eligible");
    expect(classifyCommandAuthorization({ action: "re-review", author: "randopublic" }, withPublic)).toBe("public-eligible");
    // Non-review actions are never public-eligible even with publicCommands enabled.
    for (const action of ["explain", "stop"] as const) {
      expect(classifyCommandAuthorization({ action, author: "randopublic" }, withPublic)).toBe("unauthorized");
    }
  });

  it("respects a narrowed public actions set (review only)", () => {
    const reviewOnly = { ...trusted, publicCommands: { enabled: true, actions: ["review"] as Array<"review" | "re-review">, cooldownMinutes: 10 } };
    expect(classifyCommandAuthorization({ action: "review", author: "randopublic" }, reviewOnly)).toBe("public-eligible");
    expect(classifyCommandAuthorization({ action: "re-review", author: "randopublic" }, reviewOnly)).toBe("unauthorized");
  });
});

describe("trusted request-changes authorization commands (#557)", () => {
  const HEAD = "a".repeat(40);
  const config = { enabled: true, botMentions: ["@neondiff"], trustedAuthors: ["100yenadmin"], acknowledge: false };
  const target = { repo: "owner/repo", pullNumber: 7, headSha: HEAD };

  it("collects an exact trusted command as bounded exact-head metadata and queues one review", () => {
    const commandBody = `@neondiff request-changes --repo owner/repo --pr 7 --head ${HEAD.toUpperCase()}`;
    const comments = [comment(41, "100yenadmin", commandBody)];
    const attempts = collectReviewEventAuthorizationAttempts(comments, config, target);

    expect(attempts.selected).toEqual({
      status: "eligible",
      author: "100yenadmin",
      commentId: 41,
      headSha: HEAD
    });
    expect(attempts).not.toHaveProperty("body");
    expect(JSON.stringify(attempts)).not.toContain(commandBody);
    expect(attempts.reviewRequests).toEqual([
      { action: "request-changes", commentId: 41, author: "100yenadmin", repo: "owner/repo", pullNumber: 7, headSha: HEAD }
    ]);
  });

  it("fails closed for malformed commands, mismatched targets, untrusted authors, and wildcard-only trust", () => {
    const cases = [
      { comment: comment(41, "100yenadmin", `@neondiff request-changes --repo owner/repo --pr 7 --head ${"a".repeat(39)}`), config, expected: "malformed" },
      { comment: comment(42, "100yenadmin", `@neondiff request-changes --repo other/repo --pr 7 --head ${HEAD}`), config, expected: "stale_head" },
      { comment: comment(43, "100yenadmin", `@neondiff request-changes --repo owner/repo --pr 8 --head ${HEAD}`), config, expected: "stale_head" },
      { comment: comment(44, "100yenadmin", `@neondiff request-changes --repo owner/repo --pr 7 --head ${"b".repeat(40)}`), config, expected: "stale_head" },
      { comment: comment(45, "outside", `@neondiff request-changes --repo owner/repo --pr 7 --head ${HEAD}`), config, expected: "untrusted" },
      { comment: comment(46, "outside", `@neondiff request-changes --repo owner/repo --pr 7 --head ${HEAD}`), config: { ...config, trustedAuthors: ["*"] }, expected: "untrusted" },
      { comment: comment(47, "100yenadmin", `@neondiff request-changes --pr 7 --repo owner/repo --head ${HEAD}`), config, expected: "malformed" },
      { comment: comment(48, "100yenadmin", `@neondiff request-changes --repo owner/repo --pr 7 --head ${HEAD} extra`), config, expected: "malformed" }
    ] as const;

    for (const entry of cases) {
      expect(collectReviewEventAuthorizationAttempts([entry.comment], entry.config, target).selected).toMatchObject({
        status: entry.expected,
        commentId: entry.comment.id
      });
    }
  });

  it("does not treat ordinary review or re-review commands as authorization attempts", () => {
    const attempts = collectReviewEventAuthorizationAttempts([
      comment(41, "100yenadmin", "@neondiff review"),
      comment(42, "100yenadmin", "@neondiff re-review")
    ], config, target);

    expect(attempts).toEqual({ attempts: [], selected: { status: "missing" }, reviewRequests: [] });
  });

  it("deduplicates a repeated comment ID before returning review requests", () => {
    const repeated = comment(41, "100yenadmin", `@neondiff request-changes --repo owner/repo --pr 7 --head ${HEAD}`);
    const attempts = collectReviewEventAuthorizationAttempts([repeated, repeated], config, target);

    expect(attempts.attempts).toHaveLength(1);
    expect(attempts.reviewRequests).toHaveLength(1);
  });
});

describe("public command bot-author identity (#345)", () => {
  it("identifies a comment authored by the bot's own login/type as a bot command", () => {
    expect(isBotCommandComment({ login: "evaos-code-review-bot[bot]", type: "Bot" }, "evaos-code-review-bot[bot]")).toBe(true);
    // A GitHub App bot with matching Bot type but different login is still a bot actor.
    expect(isBotCommandComment({ login: "dependabot[bot]", type: "Bot" }, "evaos-code-review-bot[bot]")).toBe(true);
    // A human author is not a bot.
    expect(isBotCommandComment({ login: "randopublic", type: "User" }, "evaos-code-review-bot[bot]")).toBe(false);
    expect(isBotCommandComment(null, "evaos-code-review-bot[bot]")).toBe(false);
  });

  it("rejects ANY Bot-type actor, not just the app's own login (deliberate breadth, loop protection)", () => {
    // Pins the intended breadth vs the narrower GitHubApi.isBotAuthoredComment (which needs BOTH
    // type === "Bot" AND login === botLogin). A third-party bot triggering a public review must be
    // blocked, so type === "Bot" alone (any login) rejects.
    expect(isBotCommandComment({ login: "third-party-app[bot]", type: "Bot" }, "evaos-code-review-bot[bot]")).toBe(true);
    expect(isBotCommandComment({ login: "renovate[bot]", type: "Bot" }, "evaos-code-review-bot[bot]")).toBe(true);
  });
});

describe("public command config validation (#345)", () => {
  const baseCommands = { commands: { enabled: true, botMentions: ["@bot"], trustedAuthors: ["100yenadmin"], acknowledge: false } };

  it("defaults publicCommands unset (byte-identical) and accepts a valid config", () => {
    expect(loadConfigFromObject({ ...baseCommands }).commands.publicCommands).toBeUndefined();
    const config = loadConfigFromObject({
      commands: { ...baseCommands.commands, publicCommands: { enabled: true, actions: ["review", "re-review"], cooldownMinutes: 10 } }
    });
    expect(config.commands.publicCommands).toEqual({ enabled: true, actions: ["review", "re-review"], cooldownMinutes: 10 });
  });

  it("fails closed on non-review actions, empty actions, bad cooldown, and unknown keys", () => {
    const pub = (publicCommands: unknown) => () => loadConfigFromObject({ commands: { ...baseCommands.commands, publicCommands } });
    expect(pub({ enabled: "yes", actions: ["review"], cooldownMinutes: 10 })).toThrow(/publicCommands\.enabled must be a boolean/);
    expect(pub({ enabled: true, actions: ["review", "explain"], cooldownMinutes: 10 })).toThrow(/publicCommands\.actions entries must be one of review, re-review/);
    expect(pub({ enabled: true, actions: ["stop"], cooldownMinutes: 10 })).toThrow(/publicCommands\.actions entries must be one of review, re-review/);
    expect(pub({ enabled: true, actions: [], cooldownMinutes: 10 })).toThrow(/publicCommands\.actions must be a non-empty array/);
    expect(pub({ enabled: true, actions: ["review"], cooldownMinutes: 0 })).toThrow(/publicCommands\.cooldownMinutes must be a positive integer/);
    expect(pub({ enabled: true, actions: ["review"], cooldownMinutes: 10, bogus: 1 })).toThrow(/publicCommands has unknown key "bogus"/);
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
