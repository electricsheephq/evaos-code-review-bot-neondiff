import { describe, expect, it } from "vitest";
import type { Finding, PullFilePatch } from "../src/types.js";
import {
  buildReviewEnsembleLeafPrompt,
  buildReviewEnsemblePlan,
  executeReviewEnsemble,
  reduceReviewEnsemble,
  type ReviewEnsembleLeafReceipt,
  type ReviewEnsembleSubject
} from "../src/review-ensemble.js";

const subject: ReviewEnsembleSubject = {
  repo: "owner/repo",
  pullNumber: 42,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40)
};

const files: PullFilePatch[] = [
  {
    filename: "src/session.ts",
    patch: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;"
  }
];

const finding: Finding = {
  severity: "P2",
  path: "src/session.ts",
  line: 1,
  title: "Resume loses the active session",
  body: "The resumed path resets state before the caller can reuse it.",
  confidence: 0.96,
  category: "runtime_correctness",
  why_this_matters: "A supported resume request returns an unusable session."
};

describe("review ensemble planning", () => {
  it("is absent by default and plans one canonical ordered team when enabled", () => {
    expect(buildReviewEnsemblePlan({ enabled: false, mode: "shadow" })).toBeUndefined();

    expect(buildReviewEnsemblePlan({ enabled: true, mode: "shadow" })).toEqual({
      version: "review-ensemble-plan-v0.1",
      mode: "shadow",
      leaves: [
        { id: "anchor", required: true },
        { id: "state", required: true },
        { id: "boundary", required: true },
        { id: "failure", required: true }
      ]
    });
  });

  it("keeps the anchor prompt unchanged and makes specialist prompts advisory", () => {
    const prompt = "Review this immutable diff.";
    expect(buildReviewEnsembleLeafPrompt(prompt, "anchor")).toBe(prompt);

    const statePrompt = buildReviewEnsembleLeafPrompt(prompt, "state");
    expect(statePrompt).toContain("State and lifecycle review");
    expect(statePrompt).toContain("Do not use tools");
    expect(statePrompt).toContain("smallest safe fix direction");
    expect(statePrompt).toContain(prompt);
  });
});

describe("review ensemble execution", () => {
  it("executes every required leaf concurrently and records one complete manifest", async () => {
    const plan = buildReviewEnsemblePlan({ enabled: true, mode: "shadow" });
    if (!plan) throw new Error("expected plan");
    let active = 0;
    let maxActive = 0;

    const run = await executeReviewEnsemble({
      plan,
      subject,
      startedAt: "2026-08-09T12:00:00.000Z",
      completedAt: () => "2026-08-09T12:00:01.000Z",
      runLeaf: async (leaf) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return { findings: [{ ...finding, title: `${finding.title} (${leaf.id})` }], dropped: [] };
      }
    });

    expect(maxActive).toBe(4);
    expect(run.manifest.complete).toBe(true);
    expect(run.manifest.leaves.map((leaf) => [leaf.id, leaf.status])).toEqual([
      ["anchor", "completed"],
      ["state", "completed"],
      ["boundary", "completed"],
      ["failure", "completed"]
    ]);
  });

  it("fails closed on required coverage while retaining successful leaf evidence", async () => {
    const plan = buildReviewEnsemblePlan({ enabled: true, mode: "shadow" });
    if (!plan) throw new Error("expected plan");

    const run = await executeReviewEnsemble({
      plan,
      subject,
      runLeaf: async (leaf) => {
        if (leaf.id === "failure") throw new Error("provider failed for token ghp" + "_secret_value");
        return { findings: [finding], dropped: [] };
      }
    });

    expect(run.manifest.complete).toBe(false);
    expect(run.manifest.leaves.find((leaf) => leaf.id === "failure")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("[redacted-secret]")
    });
    expect(run.receipts).toHaveLength(4);
    expect(run.receipts.filter((receipt) => receipt.status === "completed")).toHaveLength(3);
  });
});

describe("review ensemble reduction", () => {
  it("deduplicates across all lanes once and records fingerprint provenance", () => {
    const receipts = ["failure", "anchor", "boundary", "state"].map((id) => completedReceipt(id as ReviewEnsembleLeafReceipt["leafId"], [finding]));

    const packet = reduceReviewEnsemble({
      subject,
      files,
      receipts,
      generatedAt: "2026-08-09T12:00:02.000Z"
    });

    expect(packet.complete).toBe(true);
    expect(packet.gate.comments).toHaveLength(1);
    expect(packet.gate.dropped.filter((entry) => entry.reason === "same_run_near_duplicate")).toHaveLength(3);
    expect(Object.values(packet.provenance)).toEqual([["anchor", "state", "boundary", "failure"]]);
    expect(packet.postingEligible).toBe(false);
    expect(packet.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects mixed immutable subjects before reduction", () => {
    const receipt = completedReceipt("anchor", [finding]);
    receipt.subject = { ...subject, headSha: "c".repeat(40) };

    expect(() => reduceReviewEnsemble({ subject, files, receipts: [receipt] })).toThrow(/head SHA mismatch/);
  });

  it("keeps partial results visible but incomplete when a required lens failed", () => {
    const packet = reduceReviewEnsemble({
      subject,
      files,
      receipts: [
        completedReceipt("anchor", [finding]),
        completedReceipt("state", []),
        completedReceipt("boundary", []),
        {
          leafId: "failure",
          required: true,
          status: "failed",
          subject,
          findings: [],
          dropped: [],
          error: "timeout"
        }
      ]
    });

    expect(packet.complete).toBe(false);
    expect(packet.gate.comments).toHaveLength(1);
    expect(packet.postingEligible).toBe(false);
  });
});

function completedReceipt(
  leafId: ReviewEnsembleLeafReceipt["leafId"],
  findings: Finding[]
): ReviewEnsembleLeafReceipt {
  return {
    leafId,
    required: true,
    status: "completed",
    subject,
    findings,
    dropped: []
  };
}
