import { describe, expect, it } from "vitest";
import type { CommandConfig } from "../src/config.js";
import type { IssueCommentCommandSource } from "../src/commands.js";
import { resolveEvidenceCommandDecision, type EvidenceRead } from "../src/evidence-decision.js";

const config: CommandConfig = { enabled: true, botMentions: ["@neondiff"], trustedAuthors: ["owner"], acknowledge: false };
const target = { repo: "owner/repo", pullNumber: 7, headSha: "a".repeat(40) };
const comment = (id: number, body: string, updatedAt = "2026-01-01T00:00:00Z", login = "owner"): IssueCommentCommandSource =>
  ({ id, body, updated_at: updatedAt, user: { login } });
const read = (status: "complete" | "truncated", comments: IssueCommentCommandSource[]): EvidenceRead => ({ status, comments });
const decide = (bounded: EvidenceRead, uncapped?: EvidenceRead) => resolveEvidenceCommandDecision({
  ...target, config, bounded, uncapped, isProcessedCommand: () => false
});

describe("evidence command decision", () => {
  it("uses the provably newer overlapping edit", () => {
    const result = decide(
      read("complete", [comment(1, "@neondiff review")]),
      read("complete", [comment(1, "@neondiff stop", "2026-01-01T00:01:00Z")])
    );
    expect(result).toMatchObject({ evidenceComplete: true, decision: { action: "stop", shouldReview: false } });
    expect(decide(read("complete", [comment(2, "@neondiff review")]), read("complete", []))).toMatchObject({
      evidenceComplete: true, decision: { action: "none", shouldReview: false }
    });
  });

  it("fails closed when conflicting overlap has no authoritative edit identity", () => {
    const bounded = { id: 1, body: "@neondiff review", user: { login: "owner" } };
    const uncapped = { id: 1, body: "@neondiff stop", user: { login: "owner" } };
    expect(decide(read("complete", [bounded]), read("complete", [uncapped]))).toMatchObject({
      evidenceComplete: false, reason: "ambiguous_overlap", decision: { action: "none", shouldReview: false }
    });
  });

  it("preserves complete bounded stop when the redundant read fails", () => {
    expect(decide(read("complete", [comment(1, "@neondiff stop")]), { status: "failed" })).toMatchObject({
      evidenceComplete: true, decision: { action: "stop", shouldReview: false }
    });
  });

  it("admits only trusted explicit page-6 review requests", () => {
    const bounded = Array.from({ length: 500 }, (_unused, index) => comment(index + 1, "discussion"));
    const body = `@neondiff request-changes --repo ${target.repo} --pr ${target.pullNumber} --head ${target.headSha}`;
    expect(decide(read("truncated", bounded), read("complete", [...bounded, comment(501, body)]))).toMatchObject({
      evidenceComplete: false, reason: "uncapped_explicit_command", decision: { action: "request-changes", shouldReview: true }
    });
    expect(decide(read("truncated", bounded), read("complete", [...bounded, comment(501, "@neondiff review", undefined, "stranger")]))).toMatchObject({
      evidenceComplete: false, decision: { action: "none", shouldReview: false }
    });
  });

  it("keeps uncapped-only no-command evidence fail-closed", () => {
    expect(decide({ status: "failed" }, read("complete", []))).toMatchObject({
      evidenceComplete: false, decision: { action: "none", shouldReview: false }
    });
  });

  it("treats an exact complete 500 boundary as authoritative and honors processed commands", () => {
    const comments = Array.from({ length: 499 }, (_unused, index) => comment(index + 1, "discussion"));
    comments.push(comment(500, "@neondiff review"));
    const result = resolveEvidenceCommandDecision({
      ...target, config, bounded: read("complete", comments), isProcessedCommand: (command) => command.commentId === 500
    });
    expect(result).toMatchObject({ evidenceComplete: true, decision: { action: "none", shouldReview: false } });
  });
});
