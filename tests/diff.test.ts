import { describe, expect, it } from "vitest";
import { collectRightSideLines, validateFindingLocations } from "../src/diff.js";
import type { Finding } from "../src/types.js";

describe("diff coordinate validation", () => {
  const files = [
    {
      filename: "src/game/combat.ts",
      patch: [
        "@@ -10,5 +10,7 @@ export function resolveTurn() {",
        " const before = true;",
        "-const removed = legacy();",
        "+const added = nextFrame();",
        "+const alsoAdded = true;",
        " return before;",
        "@@ -42,2 +44,3 @@ export function render() {",
        " draw();",
        "+flush();"
      ].join("\n")
    }
  ];

  it("treats only RIGHT-side diff lines as inline-commentable", () => {
    const lines = collectRightSideLines(files);

    expect(lines.get("src/game/combat.ts")).toEqual(new Set([10, 11, 12, 13, 44, 45]));
  });

  it("drops deleted, missing, and out-of-diff findings while preserving valid findings", () => {
    const findings: Finding[] = [
      { severity: "P1", path: "src/game/combat.ts", line: 11, title: "Valid", body: "This is valid.", confidence: 0.9 },
      { severity: "P1", path: "src/game/combat.ts", line: 12, title: "Also valid", body: "This is also valid.", confidence: 0.9 },
      { severity: "P1", path: "src/game/combat.ts", line: 9, title: "Deleted", body: "Cannot comment here.", confidence: 0.9 },
      { severity: "P1", path: "src/other.ts", line: 1, title: "Missing", body: "Wrong file.", confidence: 0.9 }
    ];

    const result = validateFindingLocations(findings, files);

    expect(result.valid.map((finding) => finding.title)).toEqual(["Valid", "Also valid"]);
    expect(result.dropped).toEqual([
      expect.objectContaining({ title: "Deleted", reason: "line_not_in_current_diff" }),
      expect.objectContaining({ title: "Missing", reason: "file_not_in_diff" })
    ]);
  });
});
