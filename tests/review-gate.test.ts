import { describe, expect, it } from "vitest";
import { applyDeterministicReviewGate } from "../src/review-gate.js";
import type { Finding, PullFilePatch } from "../src/types.js";

describe("deterministic review gate", () => {
  const files: PullFilePatch[] = [
    {
      filename: "src/save.ts",
      patch: "@@ -1,2 +1,3 @@\n export function save() {\n+  overwriteAllData();\n }"
    }
  ];

  it("owns final line, category, event, and drop decisions", () => {
    const findings: Finding[] = [
      {
        severity: "P1",
        category: "data_loss",
        path: "src/save.ts",
        line: 2,
        title: "Rollback can clobber fresh state",
        body: "The added call can overwrite newer data after a failed save.",
        confidence: 0.9
      },
      {
        severity: "P1",
        category: "data_loss",
        path: "src/save.ts",
        line: 99,
        title: "Wrong line",
        body: "This is not on the current RIGHT-side diff.",
        confidence: 0.9
      }
    ];

    const gate = applyDeterministicReviewGate({ findings, files, droppedFromSchema: [{ reason: "invalid_schema" }] });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.comments).toHaveLength(1);
    expect(gate.comments[0]).toMatchObject({ category: "data_loss", severity: "P1", line: 2 });
    expect(gate.summary).toMatchObject({
      inputFindings: 2,
      acceptedComments: 1,
      droppedFindings: 2,
      event: "REQUEST_CHANGES",
      requestChangesEligible: 1,
      categoryCounts: { data_loss: 1 },
      dropReasonCounts: { invalid_schema: 1, line_not_in_current_diff: 1 }
    });
  });

  it("keeps high-severity proof gaps blocking because severity is authoritative", () => {
    const gate = applyDeterministicReviewGate({
      files,
      findings: [
        {
          severity: "P1",
          category: "proof_gap",
          path: "src/save.ts",
          line: 2,
          title: "Missing smoke proof",
          body: "The PR does not mention a focused smoke run.",
          confidence: 0.8
        }
      ]
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
  });

  it("does not let docs-only category demote high-severity findings", () => {
    const gate = applyDeterministicReviewGate({
      files: [
        {
          filename: "docs/operator-cli.md",
          patch: "@@ -1,1 +1,2 @@\n Run rollback.\n+Run unsafe rollback."
        }
      ],
      findings: [
        {
          severity: "P0",
          category: "docs_only",
          path: "docs/operator-cli.md",
          line: 2,
          title: "Unsafe rollback command",
          body: "The documented rollback command points at the wrong live config.",
          confidence: 0.95
        }
      ]
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.categoryCounts).toEqual({ release_regression: 1 });
  });
});
