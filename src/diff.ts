import type { DroppedFinding, Finding, PullFilePatch } from "./types.js";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function collectRightSideLines(
  files: PullFilePatch[], { requireHunkLinePrefixes = false } = {}
): Map<string, Set<number>> {
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

      if (requireHunkLinePrefixes) {
        // Only actual context and added rows can ground a finding in a rendered patch.
        if (!rawLine.startsWith(" ") && !rawLine.startsWith("+")) continue;
      } else if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
        continue;
      }

      lines.add(newLine);
      newLine += 1;
    }

    if (lines.size > 0) byPath.set(file.filename, lines);
  }

  return byPath;
}

export function isPatchlessChangedFile(file: PullFilePatch): boolean {
  return !file.patch?.split("\n").some((line) => HUNK_HEADER.test(line)) && (
    file.status === "added" || file.status === "modified" ||
    ((file.status === "renamed" || file.status === "copied") &&
      ((file.changes ?? 0) > 0 || (file.additions ?? 0) + (file.deletions ?? 0) > 0))
  );
}

/** Finding citations must already be verified against the checkout by the review runtime. */
export function validateFindingLocations(
  findings: Finding[], files: PullFilePatch[], headLineCounts?: ReadonlyMap<string, number>,
  outsideDiffShownLines?: ReadonlyMap<string, ReadonlySet<number>>
): {
  valid: Finding[];
  dropped: DroppedFinding[];
  outsideDiff: Finding[];
} {
  const rightLines = collectRightSideLines(files);
  const pathsWithoutPatch = new Set(files.filter(isPatchlessChangedFile).map((file) => file.filename));
  const valid: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  const outsideDiff: Finding[] = [];

  for (const finding of findings) {
    const fileLines = rightLines.get(finding.path);
    if (!fileLines) {
      if (!pathsWithoutPatch.has(finding.path)) {
        dropped.push({ ...finding, reason: "file_not_in_diff" });
      } else if (headLineCounts && !(Number.isInteger(finding.line) && finding.line >= 1 &&
          finding.line <= (headLineCounts.get(finding.path) ?? 0))) {
        dropped.push({ ...finding, reason: "outside_diff_line_not_in_head_file" });
      } else if (!outsideDiffShownLines?.get(finding.path)?.has(finding.line) && !finding.evidence?.some((ref) =>
        ref.path === finding.path && ref.startLine <= finding.line && finding.line <= ref.endLine
      )) {
        dropped.push({ ...finding, reason: "outside_diff_without_evidence" });
      } else {
        outsideDiff.push(finding);
      }
      continue;
    }
    if (!fileLines.has(finding.line)) {
      dropped.push({ ...finding, reason: "line_not_in_current_diff" });
      continue;
    }
    valid.push(finding);
  }

  return { valid, dropped, outsideDiff };
}
