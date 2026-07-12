import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export function resolveConfinedEvidenceOutputPath(cwd, outputPath) {
  if (isAbsolute(outputPath)) throw new Error("evidence output must be relative and stay within docs/evidence");
  const canonicalCwd = realpathSync(cwd);
  const evidenceRoot = realpathSync(resolve(canonicalCwd, "docs", "evidence"));
  const absoluteOutput = resolve(canonicalCwd, outputPath);
  const syntacticRelative = relative(evidenceRoot, absoluteOutput);
  if (syntacticRelative.startsWith("..") || isAbsolute(syntacticRelative)) {
    throw new Error("evidence output must stay within docs/evidence");
  }

  const outputParent = dirname(absoluteOutput);
  let existingParent = outputParent;
  while (!existsSync(existingParent)) {
    const next = dirname(existingParent);
    if (next === existingParent) throw new Error("evidence output parent could not be resolved");
    existingParent = next;
  }
  assertConfined(evidenceRoot, realpathSync(existingParent));
  mkdirSync(outputParent, { recursive: true });
  assertConfined(evidenceRoot, realpathSync(outputParent));
  if (existsSync(absoluteOutput)) assertConfined(evidenceRoot, realpathSync(absoluteOutput));
  return absoluteOutput;
}

function assertConfined(evidenceRoot, candidate) {
  const confined = relative(evidenceRoot, candidate);
  if (confined.startsWith("..") || isAbsolute(confined)) {
    throw new Error("evidence output must stay within docs/evidence after resolving symlinks");
  }
}
