import { describe, expect, it } from "vitest";
import { validateFindingLocations } from "../src/diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "../src/findings.js";
import type { Finding } from "../src/types.js";

describe("synthetic high-severity review fixture", () => {
  it("turns a validated P1 regression finding into REQUEST_CHANGES", () => {
    const files = [
      {
        filename: "Assets/Scripts/CombatTurn.cs",
        patch: [
          "@@ -25,4 +25,5 @@ public void ResolveTurn() {",
          " ApplyStartOfTurnEffects();",
          "+player.Health = 1;",
          " ResolveQueuedActions();",
          " }"
        ].join("\n")
      }
    ];
    const findings: Finding[] = [
      {
        severity: "P1",
        path: "Assets/Scripts/CombatTurn.cs",
        line: 26,
        title: "Combat health reset breaks active fights",
        body: "The new assignment forces every player to one health during turn resolution, which can incorrectly kill or near-kill healthy players.",
        confidence: 0.96,
        why_this_matters: "This is a deterministic gameplay regression in the core combat loop."
      }
    ];

    const located = validateFindingLocations(findings, files);
    const normalized = normalizeFindingsForReview(located.valid);

    expect(located.dropped).toEqual([]);
    expect(normalized.comments).toHaveLength(1);
    expect(decideReviewEvent(normalized.comments)).toBe("REQUEST_CHANGES");
  });
});
