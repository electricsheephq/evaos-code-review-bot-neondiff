import type { DroppedFinding, Finding, PullFilePatch } from "./types.js";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function collectRightSideLines(files: PullFilePatch[]): Map<string, Set<number>> {
  const byPath = new Map<string, Set<number>>();

  for (const file of files) {
    const lines = new Set<number>();
    let newLine: number | null = null;

    for (const rawLine of (file.patch ?? "").split("\n")) {
      const hunk = rawLine.match(HUNK_HEADER);
      if (hunk) {
        newLine = Number(hunk[1]);
        continue;
      }

      if (newLine === null || rawLine.startsWith("\\ No newline")) continue;

      if (rawLine.startsWith("+") && !rawLine.startsWith("+++")) {
        lines.add(newLine);
        newLine += 1;
        continue;
      }

      if (rawLine.startsWith("-") && !rawLine.startsWith("---")) continue;

      lines.add(newLine);
      newLine += 1;
    }

    if (lines.size > 0) byPath.set(file.filename, lines);
  }

  return byPath;
}

export function validateFindingLocations(findings: Finding[], files: PullFilePatch[]): {
  valid: Finding[];
  dropped: DroppedFinding[];
} {
  const rightLines = collectRightSideLines(files);
  const valid: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    const fileLines = rightLines.get(finding.path);
    if (!fileLines) {
      dropped.push({ ...finding, reason: "file_not_in_diff" });
      continue;
    }
    if (!fileLines.has(finding.line)) {
      dropped.push({ ...finding, reason: "line_not_in_current_diff" });
      continue;
    }
    valid.push(finding);
  }

  return { valid, dropped };
}
