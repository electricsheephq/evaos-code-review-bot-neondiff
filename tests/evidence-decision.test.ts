import { describe, expect, it } from "vitest";
import { resolveEvidenceCommandDecision, type EvidenceRead } from "../src/evidence-decision.js";
import type { CommandConfig } from "../src/config.js";
import type { IssueCommentCommandSource } from "../src/commands.js";

const config: CommandConfig = { enabled: true, botMentions: ["@neondiff"], trustedAuthors: ["owner"], acknowledge: false };
const target = { repo: "owner/repo", pullNumber: 7, headSha: "a".repeat(40) };

function comment(id: number, body?: string, login = "owner"): IssueCommentCommandSource {
  return { id, body, user: { login } };
}
function read(status: "failed"): EvidenceRead;
function read(status: "complete" | "truncated", comments: IssueCommentCommandSource[]): EvidenceRead;
function read(status: EvidenceRead["status"], comments: IssueCommentCommandSource[] = []): EvidenceRead {
  return status === "failed" ? { status } : { status, comments };
}
function decide(bounded: EvidenceRead, uncapped?: EvidenceRead) {
  return resolveEvidenceCommandDecision({ ...target, config, bounded, uncapped, isProcessedCommand: () => false });
}

describe("evidence command decision", () => {
  it("preserves a trusted stop when the redundant uncapped read fails", () => {
    const result = decide(read("complete", [comment(1, "@neondiff stop")]), read("failed"));
    expect(result.decision).toMatchObject({ action: "stop", shouldReview: false, commandId: 1 });
    expect(result.evidenceComplete).toBe(true);
    expect(result.reason).toBe("bounded_complete_trusted_command");
  });

  it("admits only a trusted explicit page-6 review from successful uncapped evidence", () => {
    const bounded = Array.from({ length: 500 }, (_unused, index) => comment(index + 1));
    const uncapped = [...bounded, comment(501, "@neondiff review")];
    const result = decide(read("truncated", bounded), read("complete", uncapped));
    expect(result.decision).toMatchObject({ action: "review", shouldReview: true, commandId: 501 });
    expect(result.evidenceComplete).toBe(false);
    expect(result.reason).toBe("incomplete_uncapped_explicit_command");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("admits an exact-head trusted request-changes command beyond page 5", () => {
    const bounded = Array.from({ length: 500 }, (_unused, index) => comment(index + 1));
    const body = `@neondiff request-changes --repo ${target.repo} --pr ${target.pullNumber} --head ${target.headSha}`;
    const result = decide(read("truncated", bounded), read("complete", [...bounded, comment(501, body)]));
    expect(result.decision).toMatchObject({ action: "request-changes", shouldReview: true, commandId: 501 });
  });

  it("fails closed for inferred, untrusted, and failed incomplete evidence", () => {
    const bounded = Array.from({ length: 500 }, (_unused, index) => comment(index + 1));
    expect(decide(read("truncated", bounded), read("complete", [...bounded, comment(501, "@neondiff review", "stranger")]))).toMatchObject({
      decision: { action: "none", shouldReview: false }, evidenceComplete: false
    });
    expect(decide(read("truncated", bounded), read("complete", [...bounded, comment(501, "discussion")])).decision.action).toBe("none");
    expect(decide(read("failed"), read("failed")).evidenceComplete).toBe(false);
  });

  it("treats an explicitly complete 500-comment boundary as authoritative", () => {
    const bounded = Array.from({ length: 500 }, (_unused, index) => comment(index + 1));
    const result = decide(read("complete", bounded), read("failed"));
    expect(result).toMatchObject({ evidenceComplete: true, decision: { action: "none", shouldReview: false } });
  });

  it("gives processed records precedence over otherwise admissible commands", () => {
    const result = resolveEvidenceCommandDecision({
      ...target, config, bounded: read("complete", [comment(9, "@neondiff review")]),
      isProcessedCommand: (command) => command.commentId === 9
    });
    expect(result.decision).toEqual({ action: "none", shouldReview: false });
  });
});
