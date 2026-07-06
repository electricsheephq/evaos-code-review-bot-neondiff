import { describe, expect, it } from "vitest";
import {
  buildIssueHash,
  mapIssueLifecycleState,
  mapReviewOutcome,
  parseMarkerLifecycleFields,
  renderMarkerLifecycleFields
} from "../src/marker-lifecycle.js";

const FAKE_TOKEN = ["ghp", "x".repeat(36)].join("_");
const HEAD = "a".repeat(40);

describe("marker lifecycle fields", () => {
  it("renders nothing when no fields are present (back-compat)", () => {
    expect(renderMarkerLifecycleFields(undefined)).toBe("");
    expect(renderMarkerLifecycleFields({})).toBe("");
  });

  it("renders fields in a stable order with a leading space", () => {
    const rendered = renderMarkerLifecycleFields({
      runId: "repo__x-pr-1-abc",
      role: "reviewer",
      outcome: "reviewed",
      handoffTarget: "fixer-agent",
      issueHash: "0123456789abcdef"
    });
    expect(rendered).toBe(" runId=repo__x-pr-1-abc role=reviewer outcome=reviewed handoffTarget=fixer-agent issueHash=0123456789abcdef");
  });

  it("round-trips every field with and without each present", () => {
    const full = { runId: "r1", role: "enricher" as const, outcome: "enriched" as const, handoffTarget: "team-x", issueHash: "deadbeefdeadbeef" };
    const marker = `<!-- x version=1 repo=owner/repo issue=5${renderMarkerLifecycleFields(full)} -->`;
    expect(parseMarkerLifecycleFields(marker)).toMatchObject(full);

    const partial = { role: "reviewer" as const };
    const partialMarker = `<!-- x repo=owner/repo pr=1${renderMarkerLifecycleFields(partial)} -->`;
    const parsed = parseMarkerLifecycleFields(partialMarker);
    expect(parsed.role).toBe("reviewer");
    expect(parsed.runId).toBeUndefined();
    expect(parsed.outcome).toBeUndefined();
    expect(parsed.handoffTarget).toBeUndefined();
    expect(parsed.issueHash).toBeUndefined();
  });

  it("round-trips a marker WITHOUT any lifecycle fields to an empty object", () => {
    const legacy = "<!-- evaos-code-review-bot:review-status-state status=queued updated_at=2026-07-02T00:00:00.000Z -->";
    expect(parseMarkerLifecycleFields(legacy)).toEqual({});
  });

  it("round-trips the issue lifecycle state token", () => {
    const marker = "<!-- x version=1 repo=owner/repo issue=5 state=open lifecycle=deferred-by-throttle hash=abc -->";
    expect(parseMarkerLifecycleFields(marker).issueLifecycleState).toBe("deferred-by-throttle");
  });

  it("redacts secret-like handoff targets and strips marker-breaking characters", () => {
    const rendered = renderMarkerLifecycleFields({ handoffTarget: `route-to ${FAKE_TOKEN} --> evil` });
    expect(rendered).not.toContain(FAKE_TOKEN);
    expect(rendered).not.toContain("-->");
    expect(rendered).not.toContain(" evil");
  });

  it("hashes the subject stably and never exposes raw subject text", () => {
    const a = buildIssueHash({ repo: "owner/repo", pullNumber: 7, headSha: HEAD });
    const b = buildIssueHash({ repo: "owner/repo", pullNumber: 7, headSha: HEAD });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain("owner/repo");
    // Different subjects hash differently.
    expect(buildIssueHash({ repo: "owner/repo", issueNumber: 7 })).not.toBe(a);
  });
});

describe("review outcome mapping", () => {
  it("derives outcome from the existing review-status decision", () => {
    expect(mapReviewOutcome("completed")).toBe("reviewed");
    expect(mapReviewOutcome("skipped")).toBe("skipped");
    expect(mapReviewOutcome("provider_deferred")).toBe("deferred");
    expect(mapReviewOutcome("stale_head")).toBe("stale");
    expect(mapReviewOutcome("closed_or_merged_before_review")).toBe("stale");
    expect(mapReviewOutcome("queued")).toBeUndefined();
    expect(mapReviewOutcome("in_progress")).toBeUndefined();
    expect(mapReviewOutcome("failed")).toBeUndefined();
  });
});

describe("issue lifecycle state mapping", () => {
  it("maps from the existing issue-enrichment decision path", () => {
    expect(mapIssueLifecycleState({ status: "posted" })).toBe("enriched");
    expect(mapIssueLifecycleState({ status: "deferred", reason: "repo_max_comments_per_cycle" })).toBe("deferred-by-throttle");
    expect(mapIssueLifecycleState({ status: "deferred", reason: "stale_issue_closed" })).toBe("stale-head");
    expect(mapIssueLifecycleState({ status: "skipped", reason: "stale_issue_closed" })).toBe("stale-head");
    expect(mapIssueLifecycleState({ status: "skipped", reason: "issue_is_pull_request" })).toBe("needs-human-routing");
    expect(mapIssueLifecycleState({ status: "dry_run" })).toBeUndefined();
    expect(mapIssueLifecycleState({ status: "failed" })).toBeUndefined();
  });
});
