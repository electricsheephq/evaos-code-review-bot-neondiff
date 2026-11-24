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

  it.each([undefined, null, ""])("preserves a finding on a changed file whose patch is %s", (patch) => {
    const finding: Finding = {
      severity: "P2", path: "assets/bundle.js", line: 42, title: "Missing fallback",
      body: "The generated bundle omits the fallback.", confidence: 0.9
    };

    const result = validateFindingLocations([finding], [...files, { filename: finding.path, status: "modified", patch }]);

    expect(result.valid).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.outsideDiff).toEqual([finding]);
  });

  it.each([
    [{ status: "renamed", changes: 0 }, false],
    [{ status: "copied", changes: 0 }, false],
    [{ status: "changed", changes: 0 }, false],
    [{ status: "unchanged" }, false],
    [{ status: "renamed", changes: 3 }, true],
    [{ status: "copied", additions: 1 }, true]
  ] as const)("checks content changes for patchless file %j", (metadata, changed) => {
    const finding: Finding = {
      severity: "P1", path: "src/moved.ts", line: 1, title: "Missing fallback",
      body: "The fallback is omitted.", confidence: 0.9
    };
    const result = validateFindingLocations([finding], [{ filename: finding.path, ...metadata }]);
    expect(result.outsideDiff).toEqual(changed ? [finding] : []);
    expect(result.dropped).toEqual(changed ? [] : [{ ...finding, reason: "file_not_in_diff" }]);
  });

  it("drops a finding on a removed file that has no patch", () => {
    const finding: Finding = {
      severity: "P2", path: "public/game.old.js", line: 10, title: "Removed bundle",
      body: "The file is gone at head.", confidence: 0.9
    };

    const result = validateFindingLocations([finding], [{ filename: finding.path, status: "removed" }]);

    expect(result.outsideDiff).toEqual([]);
    expect(result.dropped).toEqual([{ ...finding, reason: "file_not_in_diff" }]);
  });

  it("keeps the existing drop for a deletion-only patch with no right-side lines", () => {
    const finding: Finding = {
      severity: "P2", path: "src/removed.ts", line: 1, title: "Removed file",
      body: "There is no right-side line.", confidence: 0.9
    };

    const result = validateFindingLocations([finding], [{ filename: finding.path, patch: "@@ -1 +0,0 @@\n-removed" }]);

    expect(result.outsideDiff).toEqual([]);
    expect(result.dropped).toEqual([{ ...finding, reason: "file_not_in_diff" }]);
  });
});
