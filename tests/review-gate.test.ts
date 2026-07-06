import { describe, expect, it } from "vitest";
import { applyDeterministicReviewGate, buildFindingFingerprint } from "../src/review-gate.js";
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

  it("keeps high-severity proof gaps advisory when no correctness risk category is validated", () => {
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

    expect(gate.event).toBe("COMMENT");
    expect(gate.comments).toHaveLength(1);
    expect(gate.summary.requestChangesEligible).toBe(0);
  });

  it("keeps docs-only findings advisory unless taxonomy validates a release regression", () => {
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

  it("keeps docs-only advisory while treating unknown as a blocking fallback for high-severity findings", () => {
    const gate = applyDeterministicReviewGate({
      files: [
        {
          filename: "docs/readme.md",
          patch: "@@ -1,1 +1,3 @@\n Intro.\n+Ambiguous warning.\n+Another warning."
        },
        {
          filename: "misc/ambiguous.data",
          patch: "@@ -1,1 +1,2 @@\n value=1\n+ambiguous=2"
        }
      ],
      findings: [
        {
          severity: "P0",
          category: "docs_only",
          path: "docs/readme.md",
          line: 2,
          title: "Docs-only concern",
          body: "This severe wording is limited to editorial phrasing.",
          confidence: 0.95
        },
        {
          severity: "P1",
          category: "unknown",
          path: "misc/ambiguous.data",
          line: 2,
          title: "Unknown category concern",
          body: "This severe wording is ambiguous and unactionable.",
          confidence: 0.9
        }
      ]
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
    expect(gate.summary.categoryCounts).toEqual({ docs_only: 1, unknown: 1 });
  });

  it("leaves REQUEST_CHANGES gating unchanged when no confidence floor is configured", () => {
    const findings: Finding[] = [
      {
        severity: "P0",
        category: "data_loss",
        path: "src/save.ts",
        line: 2,
        title: "Rollback can clobber fresh state",
        body: "The added call can overwrite newer data after a failed save.",
        confidence: 0.2
      }
    ];

    const gate = applyDeterministicReviewGate({ findings, files });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
  });

  it("keeps a below-floor P0 finding as a comment without requesting changes", () => {
    const findings: Finding[] = [
      {
        severity: "P0",
        category: "data_loss",
        path: "src/save.ts",
        line: 2,
        title: "Rollback can clobber fresh state",
        body: "The added call can overwrite newer data after a failed save.",
        confidence: 0.5
      }
    ];

    const gate = applyDeterministicReviewGate({
      findings,
      files,
      requestChangesConfidenceFloors: { P0: 0.8 }
    });

    expect(gate.event).toBe("COMMENT");
    expect(gate.comments).toHaveLength(1);
    expect(gate.comments[0]).toMatchObject({ severity: "P0", line: 2 });
    expect(gate.summary.requestChangesEligible).toBe(0);
  });

  it("requests changes for an at-or-above-floor P0 finding", () => {
    const findings: Finding[] = [
      {
        severity: "P0",
        category: "data_loss",
        path: "src/save.ts",
        line: 2,
        title: "Rollback can clobber fresh state",
        body: "The added call can overwrite newer data after a failed save.",
        confidence: 0.9
      }
    ];

    const gate = applyDeterministicReviewGate({
      findings,
      files,
      requestChangesConfidenceFloors: { P0: 0.8 }
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
  });

  it("requests changes for a P0 finding exactly at the floor (floor is inclusive)", () => {
    const findings: Finding[] = [
      {
        severity: "P0",
        category: "data_loss",
        path: "src/save.ts",
        line: 2,
        title: "Rollback can clobber fresh state",
        body: "The added call can overwrite newer data after a failed save.",
        confidence: 0.8
      }
    ];

    const gate = applyDeterministicReviewGate({
      findings,
      files,
      requestChangesConfidenceFloors: { P0: 0.8 }
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.summary.requestChangesEligible).toBe(1);
  });

  it("keeps a below-P1-floor finding as a comment and requests changes at or above it", () => {
    const finding: Finding = {
      severity: "P1",
      category: "data_loss",
      path: "src/save.ts",
      line: 2,
      title: "Rollback can clobber fresh state",
      body: "The added call can overwrite newer data after a failed save.",
      confidence: 0.5
    };

    const below = applyDeterministicReviewGate({
      findings: [finding],
      files,
      requestChangesConfidenceFloors: { P1: 0.6 }
    });

    expect(below.event).toBe("COMMENT");
    expect(below.comments).toHaveLength(1);
    expect(below.summary.requestChangesEligible).toBe(0);

    const atFloor = applyDeterministicReviewGate({
      findings: [{ ...finding, confidence: 0.6 }],
      files,
      requestChangesConfidenceFloors: { P1: 0.6 }
    });

    expect(atFloor.event).toBe("REQUEST_CHANGES");
    expect(atFloor.summary.requestChangesEligible).toBe(1);
  });

  it("suppresses only low-severity findings with exact repo-memory false-positive fingerprints", () => {
    const lowSeverityFinding: Finding = {
      severity: "P3",
      category: "proof_gap",
      path: "src/save.ts",
      line: 2,
      title: "Generated marker missing docs",
      body: "This low-value marker guidance was previously labeled a false positive.",
      confidence: 0.8
    };
    const highSeverityFinding: Finding = {
      ...lowSeverityFinding,
      severity: "P1",
      title: "Missing release-blocking proof"
    };
    const changedBodyFinding: Finding = {
      ...lowSeverityFinding,
      body: "This is a materially different current-diff concern and must not be hidden by old memory."
    };
    const matchingFingerprint = buildFindingFingerprint(lowSeverityFinding);

    const gate = applyDeterministicReviewGate({
      files,
      findings: [lowSeverityFinding, highSeverityFinding, changedBodyFinding],
      repoMemoryFalsePositiveFingerprints: [matchingFingerprint]
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.comments).toHaveLength(2);
    expect(gate.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: "P1", title: "Missing release-blocking proof" }),
        expect.objectContaining({ severity: "P3", title: "Generated marker missing docs" })
      ])
    );
    expect(gate.dropped).toContainEqual(
      expect.objectContaining({
        title: "Generated marker missing docs",
        reason: "repo_memory_false_positive_match",
        fingerprint: matchingFingerprint
      })
    );
    expect(gate.summary.dropReasonCounts).toMatchObject({ repo_memory_false_positive_match: 1 });
  });

  it("redacts a secret-like repo-memory-suppressed finding at the gate boundary itself (#283)", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const suppressed: Finding = {
      severity: "P3",
      category: "proof_gap",
      path: "src/save.ts",
      line: 2,
      title: "Marker with 99% confidence",
      body: `Confidence: 99%. The raw token ${token} was previously a false positive.`,
      confidence: 0.9
    };
    const matchingFingerprint = buildFindingFingerprint(suppressed);

    // No caller-side sanitization: the gate is called directly and must return public-safe drops.
    const gate = applyDeterministicReviewGate({
      files,
      findings: [suppressed],
      repoMemoryFalsePositiveFingerprints: [matchingFingerprint]
    });

    const droppedEntry = gate.dropped.find((entry) => entry.reason === "repo_memory_false_positive_match");
    expect(droppedEntry).toBeDefined();
    expect(droppedEntry).toMatchObject({ fingerprint: matchingFingerprint });
    // Secret text is redacted and confidence numbers are stripped by default (uncalibrated policy).
    expect(JSON.stringify(gate.dropped)).not.toContain(token);
    expect(droppedEntry?.title).toBe("Marker with [confidence not calibrated]");
    expect(droppedEntry?.body).toContain("Confidence: [confidence not calibrated].");
    expect(JSON.stringify(gate.dropped)).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
  });
});

describe("robust false-positive learning — coarse fallback (#302)", () => {
  const files: PullFilePatch[] = [
    {
      filename: "src/save.ts",
      patch: "@@ -40,3 +40,6 @@ export function save() {\n+  const a = 1;\n+  const b = 2;\n+  overwriteAllData();\n+  const c = 3;\n }"
    }
  ];

  function finding(overrides: Partial<Finding> & Pick<Finding, "severity" | "line" | "title">): Finding {
    return {
      category: "runtime_correctness",
      path: "src/save.ts",
      body: "A concrete review comment about the save path.",
      confidence: 0.8,
      ...overrides
    };
  }

  it("suppresses a reworded, line-shifted P3 finding via the coarse path with the distinct reason (#302)", () => {
    const current = finding({ severity: "P3", line: 44, title: "Save path retry accounting is wrong" });
    const gate = applyDeterministicReviewGate({
      files,
      findings: [current],
      repoMemoryFalsePositives: [
        {
          // Remembered at line 42 with a slightly different title; exact fingerprint won't match.
          fingerprint: buildFindingFingerprint({ ...current, line: 42, title: "Save path retry accounting" }),
          path: "src/save.ts",
          category: "runtime_correctness",
          line: 42,
          title: "Save path retry accounting"
        }
      ]
    });

    expect(gate.comments).toHaveLength(0);
    expect(gate.dropped).toContainEqual(expect.objectContaining({ reason: "repo_memory_false_positive_coarse_match" }));
    expect(gate.summary.dropReasonCounts).toMatchObject({ repo_memory_false_positive_coarse_match: 1 });
  });

  it("does NOT coarse-suppress a different genuine finding at a nearby line with a non-matching title (#302)", () => {
    const current = finding({ severity: "P3", line: 43, title: "Null deref in error branch" });
    const gate = applyDeterministicReviewGate({
      files,
      findings: [current],
      repoMemoryFalsePositives: [
        {
          fingerprint: buildFindingFingerprint({ ...current, line: 42, title: "Save path retry accounting" }),
          path: "src/save.ts",
          category: "runtime_correctness",
          line: 42,
          title: "Save path retry accounting"
        }
      ]
    });

    expect(gate.comments).toHaveLength(1);
    expect(gate.dropped).not.toContainEqual(expect.objectContaining({ reason: "repo_memory_false_positive_coarse_match" }));
  });

  it("does NOT coarse-suppress a P1 finding from an AUTO false-positive note (#302)", () => {
    const current = finding({ severity: "P1", category: "data_loss", line: 44, title: "Rollback clobbers fresh state on retry" });
    const gate = applyDeterministicReviewGate({
      files,
      findings: [current],
      repoMemoryFalsePositives: [
        {
          fingerprint: buildFindingFingerprint({ ...current, line: 42, title: "Rollback clobbers fresh state" }),
          path: "src/save.ts",
          category: "data_loss",
          line: 42,
          title: "Rollback clobbers fresh state"
          // confirmedByHuman omitted ⇒ auto note ⇒ P0/P1 must NOT be suppressed.
        }
      ]
    });

    expect(gate.comments).toHaveLength(1);
    expect(gate.dropped).not.toContainEqual(expect.objectContaining({ reason: "repo_memory_false_positive_coarse_match" }));
  });

  it("coarse-suppresses a P1 finding when the false-positive note is human-confirmed (#302)", () => {
    const current = finding({ severity: "P1", category: "data_loss", line: 44, title: "Rollback clobbers fresh state on retry" });
    const gate = applyDeterministicReviewGate({
      files,
      findings: [current],
      repoMemoryFalsePositives: [
        {
          fingerprint: buildFindingFingerprint({ ...current, line: 42, title: "Rollback clobbers fresh state" }),
          path: "src/save.ts",
          category: "data_loss",
          line: 42,
          title: "Rollback clobbers fresh state",
          confirmedByHuman: true
        }
      ]
    });

    expect(gate.comments).toHaveLength(0);
    expect(gate.dropped).toContainEqual(expect.objectContaining({ reason: "repo_memory_false_positive_coarse_match" }));
  });

  it("prefers the exact reason and does not double-count when the exact fingerprint matches (#302)", () => {
    const current = finding({ severity: "P3", line: 42, title: "Save path retry accounting" });
    const exactFingerprint = buildFindingFingerprint(current);
    const gate = applyDeterministicReviewGate({
      files,
      findings: [current],
      repoMemoryFalsePositives: [
        { fingerprint: exactFingerprint, path: "src/save.ts", category: "runtime_correctness", line: 42, title: "Save path retry accounting" }
      ]
    });

    expect(gate.summary.dropReasonCounts).toMatchObject({ repo_memory_false_positive_match: 1 });
    expect(gate.summary.dropReasonCounts.repo_memory_false_positive_coarse_match).toBeUndefined();
  });

  it("redacts a secret-bearing coarse-suppressed finding at the gate boundary (#302)", () => {
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const current = finding({
      severity: "P3",
      line: 44,
      title: "Save path retry accounting is wrong",
      body: `Leaked token ${token} in the save path retry accounting.`
    });
    const gate = applyDeterministicReviewGate({
      files,
      findings: [current],
      repoMemoryFalsePositives: [
        {
          fingerprint: buildFindingFingerprint({ ...current, line: 42, title: "Save path retry accounting" }),
          path: "src/save.ts",
          category: "runtime_correctness",
          line: 42,
          title: "Save path retry accounting"
        }
      ]
    });

    expect(gate.dropped).toContainEqual(expect.objectContaining({ reason: "repo_memory_false_positive_coarse_match" }));
    expect(JSON.stringify(gate.dropped)).not.toContain(token);
  });
});
