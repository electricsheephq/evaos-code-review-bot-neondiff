import type { ResolvedRepoProfile } from "./repo-policy.js";
import type {
  ChangedSurfaceValidationReport,
  ProofRequirementReport,
  PullFilePatch,
  PullRequestSummary,
  ValidationRecommendation
} from "./types.js";

export function buildChangedSurfaceValidationReport(input: {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  profile?: ResolvedRepoProfile;
}): ChangedSurfaceValidationReport {
  const files = input.files.map((file) => file.filename);
  const docsOnly = files.length > 0 && files.every(isDocsPath);
  const recommendations: ValidationRecommendation[] = [];

  if (docsOnly) {
    recommendations.push({
      id: "docs_review",
      title: "Docs/readme review",
      status: "recommended",
      reason: "All reviewed files are documentation paths.",
      matchedPaths: files,
      proofTypes: ["PR description notes the docs intent"]
    });
  }

  const unityPaths = files.filter(isUnityPath);
  if (unityPaths.length > 0 || isWorldOsRepo(input.repo)) {
    recommendations.push({
      id: "unity_editor_smoke",
      title: "Unity editor or Play Mode smoke",
      status: docsOnly ? "not_applicable" : "required",
      reason: unityPaths.length > 0 ? "Unity asset/script/project files changed." : "WorldOS repo profile implies Unity runtime risk.",
      matchedPaths: unityPaths,
      proofTypes: ["Unity editor smoke", "Play Mode log", "scene/prefab screenshot or recording"]
    });
  }

  const typeScriptPaths = files.filter(isTypeScriptOrWebPath);
  if (typeScriptPaths.length > 0) {
    recommendations.push({
      id: "typescript_build",
      title: "TypeScript/web build or CI proof",
      status: docsOnly ? "not_applicable" : "required",
      reason: "Runtime TypeScript/web files or package/config files changed.",
      matchedPaths: typeScriptPaths,
      proofTypes: ["npm run build", "typecheck", "focused Vitest", "green GitHub check"]
    });
  }

  const workflowPaths = files.filter(isWorkflowOrReleasePath);
  if (workflowPaths.length > 0) {
    recommendations.push({
      id: "ci_release_smoke",
      title: "CI/release smoke proof",
      status: docsOnly ? "recommended" : "required",
      reason: "CI, release, launchd, or package metadata changed.",
      matchedPaths: workflowPaths,
      proofTypes: ["green GitHub check", "release-status", "coverage-audit", "rollback note"]
    });
  }

  if (canonicalRepo(input.repo) === "electricsheephq/evaos-code-review-bot" && !docsOnly) {
    recommendations.push({
      id: "bot_focused_tests",
      title: "Review-bot focused tests and build",
      status: "required",
      reason: "The bot's own runtime or policy code changed.",
      matchedPaths: files.filter((file) => file.startsWith("src/") || file.startsWith("tests/") || file.startsWith("docs/releases/")),
      proofTypes: ["focused Vitest", "npm run build", "release-status before promotion"]
    });
  }

  const required = recommendations.filter((recommendation) => recommendation.status === "required").length;
  const summary = docsOnly
    ? "Documentation-only changed surface; runtime execution proof is not required by default."
    : required > 0
      ? `${required} required validation/proof recommendation(s) selected from changed files.`
      : "No required validation recommendation selected; rely on existing GitHub checks and human review.";

  return {
    summary,
    docsOnly,
    recommendations: dedupeRecommendations(recommendations),
    profileHints: {
      validationHints: input.profile?.validationHints ?? [],
      proofExpectations: input.profile?.proofExpectations ?? []
    }
  };
}

export function evaluateProofRequirements(input: {
  pull: PullRequestSummary;
  validation: ChangedSurfaceValidationReport;
}): ProofRequirementReport {
  const required = input.validation.recommendations.filter((recommendation) => recommendation.status === "required");
  if (required.length === 0) {
    return {
      status: "not_applicable",
      summary: "No required behavior proof selected for this changed surface.",
      requiredRecommendationIds: [],
      missingRecommendationIds: [],
      detectedEvidence: []
    };
  }

  const text = `${input.pull.title}\n${input.pull.body ?? ""}`;
  const detectedEvidence = detectEvidenceMentions(text);
  const missing = required.filter((recommendation) => !hasEvidenceForRecommendation(recommendation, text));

  return {
    status: missing.length === 0 ? "sufficient" : "missing",
    summary:
      missing.length === 0
        ? "PR metadata mentions acceptable proof for each required validation recommendation."
        : `${missing.length} required validation/proof recommendation(s) missing from PR metadata.`,
    requiredRecommendationIds: required.map((recommendation) => recommendation.id),
    missingRecommendationIds: missing.map((recommendation) => recommendation.id),
    detectedEvidence
  };
}

function dedupeRecommendations(recommendations: ValidationRecommendation[]): ValidationRecommendation[] {
  const byId = new Map<string, ValidationRecommendation>();
  for (const recommendation of recommendations) {
    if (!byId.has(recommendation.id)) byId.set(recommendation.id, recommendation);
  }
  return [...byId.values()];
}

function hasEvidenceForRecommendation(recommendation: ValidationRecommendation, text: string): boolean {
  const normalized = text.toLowerCase();
  if (recommendation.id === "unity_editor_smoke") return hasUnityEvidence(normalized);
  if (recommendation.id === "typescript_build") return hasBuildEvidence(normalized) || hasTestEvidence(normalized) || hasCiEvidence(normalized);
  if (recommendation.id === "ci_release_smoke") return hasReleaseEvidence(normalized) || hasCiEvidence(normalized);
  if (recommendation.id === "bot_focused_tests") return hasBuildEvidence(normalized) && hasTestEvidence(normalized);
  return recommendation.proofTypes.some((proofType) => normalized.includes(proofType.toLowerCase()));
}

function detectEvidenceMentions(text: string): string[] {
  const normalized = text.toLowerCase();
  const evidence = new Set<string>();
  if (hasUnityEvidence(normalized)) evidence.add("Unity smoke");
  if (hasVisualEvidence(normalized)) evidence.add("visual proof");
  if (hasBuildEvidence(normalized)) evidence.add("build/typecheck");
  if (hasTestEvidence(normalized)) evidence.add("tests");
  if (hasCiEvidence(normalized)) evidence.add("CI checks");
  if (hasReleaseEvidence(normalized)) evidence.add("release/operator checks");
  return [...evidence];
}

function hasBuildEvidence(text: string): boolean {
  return hasUnnegatedProof(text, ["build", "validation", "typecheck", "tsc"], [
    /\b(npm run build|pnpm build|yarn build|bun run build|typecheck|tsc --noemit|tsc -p)\b/,
    /\b(build|tsc)\b.{0,48}?\b(pass(?:ed|es)?|green|ok|succeed(?:ed|s)?)\b/,
    /\b(pass(?:ed|es)?|green|ok|succeed(?:ed|s)?)\b.{0,48}?\b(build|tsc)\b/
  ]);
}

function hasTestEvidence(text: string): boolean {
  return hasUnnegatedProof(text, ["validation", "test", "tests", "vitest", "jest", "npm test"], [
    /\b(focused\s+)?(vitest|jest|unit tests?|tests?|npm test)\b.{0,48}?\b(pass(?:ed|es)?|green|succeed(?:ed|s)?)\b/,
    /\b(pass(?:ed|es)?|green|succeed(?:ed|s)?)\b.{0,48}?\b(focused\s+)?(vitest|jest|unit tests?|tests?|npm test)\b/
  ]);
}

function hasCiEvidence(text: string): boolean {
  return hasUnnegatedProof(text, ["validation", "ci", "check", "checks"], [
    /\b(all checks? (?:are |is )?green|ci (?:run|pipeline) passed|github actions (?:run )?green|github checks passed)\b/
  ]);
}

function hasReleaseEvidence(text: string): boolean {
  return hasUnnegatedProof(text, ["validation", "release:status", "coverage-audit", "provider-cooldown", "rollback"], [
    /\b(release:status|coverage-audit|provider-cooldowns?|rollback note)\b/
  ]);
}

function hasUnityEvidence(text: string): boolean {
  return hasUnnegatedProof(text, ["validation", "play mode", "playmode", "unity", "scene smoke", "prefab smoke"], [
    /\b(play\s*mode|playmode|unity editor|scene smoke|prefab smoke)\b.{0,48}?\b(pass(?:ed|es)?|green|ok|smoke(?:d)?|verified)\b/
  ]) || hasVisualEvidence(text);
}

function hasVisualEvidence(text: string): boolean {
  return hasUnnegatedProof(text, ["screenshot", "recording", "video", "visual proof"], [
    /\b(screenshot|recording|video)\b.{0,48}?\b(attached|captured|included|provided|uploaded)\b/,
    /\b(attached|captured|included|provided|uploaded)\b.{0,48}?\b(screenshot|recording|video)\b/
  ]);
}

// A proof mention counts unless a negation sits in its own sentence or in a line that governs it:
// its markdown section headings, an enclosing parent bullet, or a "Previous validation:" lead-in
// above it. An unrelated "no ..." in another bullet or sentence does not erase it.
function hasUnnegatedProof(text: string, negationWords: string[], positives: RegExp[]): boolean {
  const lines = proofLines(text);
  const negatedLine: Array<boolean | undefined> = [];
  const isNegatedLine = (index: number) =>
    (negatedLine[index] ??= hasNegatedOrHistoricalProof(lines[index]!.text, negationWords));
  return positives.some((positive) => {
    const pattern = new RegExp(positive.source, "g");
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      // Minimal matches only; one that crosses a sentence end borrows its outcome from the next sentence.
      if (!CROSSES_SENTENCE_END.test(match[0])) {
        const lineIndex = lineIndexAt(lines, match.index);
        if (!hasNegatedOrHistoricalProof(proofSentence(text, lines, lineIndex, match), negationWords) &&
          !lines[lineIndex]!.governing.some(isNegatedLine)) return true;
      }
      // Retry from the next character so a rejected match cannot hide later proof it overlaps.
      pattern.lastIndex = match.index + 1;
    }
    return false;
  });
}

const PROOF_SENTENCE_REACH = 400;
// "worker.ts", "1.0.6", "e.g. npm run build" and "(incl. assets)" do not end a sentence; ";" does not
// either, so "previous validation: build passed; tests passed" stays one sentence.
const SENTENCE_END = /(?<!\b(?:e\.g|i\.e|eg|ie|etc|vs|cf|incl|approx|esp|al|fig))[.!?]\s/g;
const CROSSES_SENTENCE_END = new RegExp(SENTENCE_END.source);

// The whole sentence counts, so a trailing qualifier ("tests passed (previous validation only)") still vetoes.
function proofSentence(text: string, lines: ProofLine[], lineIndex: number, match: RegExpExecArray): string {
  const line = lines[lineIndex]!;
  const matchEnd = match.index + match[0].length;
  const lineEnd = line.start + line.text.length;
  const windowStart = Math.max(line.start, match.index - PROOF_SENTENCE_REACH);
  let sentenceStart = windowStart;
  for (const boundary of text.slice(windowStart, match.index).matchAll(SENTENCE_END)) {
    sentenceStart = windowStart + boundary.index + boundary[0].length;
  }
  const after = text.slice(matchEnd, Math.max(matchEnd, Math.min(lineEnd, matchEnd + PROOF_SENTENCE_REACH)));
  const end = new RegExp(SENTENCE_END.source).exec(after);
  return text.slice(sentenceStart, end === null ? matchEnd + after.length : matchEnd + end.index + 1);
}

interface ProofLine {
  start: number;
  text: string;
  // Indices of earlier lines that qualify this one.
  governing: number[];
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;
const MARKDOWN_HEADING = /^\s{0,3}(#{1,6})\s/;

const CODE_FENCE = /^\s{0,3}(?:```|~~~)/;

function proofLines(text: string): ProofLine[] {
  let offset = 0;
  const headings: Array<{ level: number; index: number }> = [];
  const parents: Array<{ indent: number; index: number }> = [];
  let leadIn: number | undefined;
  let listLeadIn: number | undefined;
  let afterBlank = false;
  let inFence = false;
  const listScope = () => [
    ...(listLeadIn === undefined ? [] : [listLeadIn]),
    ...(leadIn === undefined || leadIn === listLeadIn ? [] : [leadIn]),
    ...parents.map((parent) => parent.index)
  ];
  return text.split("\n").map((line, index) => {
    const start = offset;
    offset += line.length + 1;
    const governing = headings.map((heading) => heading.index);
    // Fenced code is content of the section it sits in; its "## Example" or "- item" lines are not structure.
    if (CODE_FENCE.test(line)) inFence = !inFence;
    if (inFence || CODE_FENCE.test(line)) return { start, text: line, governing: [...governing, ...listScope()] };
    const heading = MARKDOWN_HEADING.exec(line);
    if (heading) {
      // A subsection stays under its parent heading until a heading of the same or a higher level.
      const level = heading[1]!.length;
      while (headings.length > 0 && headings[headings.length - 1]!.level >= level) headings.pop();
      const ancestors = headings.map((ancestor) => ancestor.index);
      headings.push({ level, index });
      parents.length = 0;
      leadIn = undefined;
      listLeadIn = undefined;
      afterBlank = false;
      return { start, text: line, governing: ancestors };
    }
    if (line.trim() === "") {
      afterBlank = true;
      return { start, text: line, governing };
    }
    const indent = line.search(/\S/);
    if (LIST_ITEM.test(line)) {
      while (parents.length > 0 && parents[parents.length - 1]!.indent >= indent) parents.pop();
      governing.push(...listScope());
      parents.push({ indent, index });
    } else if (indent > 0 && parents.length > 0) {
      // An indented line under a bullet continues that bullet ("- Previous validation:\n  Build passed.").
      while (parents.length > 0 && parents[parents.length - 1]!.indent >= indent) parents.pop();
      governing.push(...listScope());
    } else {
      // Prose directly under a colon lead-in stays in its scope; prose after a blank line starts a new block.
      if (afterBlank) leadIn = undefined;
      parents.length = 0;
      if (leadIn !== undefined) governing.push(leadIn);
      // Any prose line introduces the list that follows it, colon or not ("Previous validation").
      listLeadIn = index;
      if (/:[*_`]*$/.test(line.trimEnd())) leadIn = index;
    }
    afterBlank = false;
    return { start, text: line, governing };
  });
}

function lineIndexAt(lines: ProofLine[], index: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lines[middle]!.start <= index) low = middle; else high = middle - 1;
  }
  return low;
}

function hasNegatedOrHistoricalProof(text: string, evidenceWords: string[]): boolean {
  const evidencePattern = evidenceWords.map(escapeRegExp).join("|");
  return new RegExp(`\\b(no|not|without|missing|previous|prior|reverted)\\b.{0,48}\\b(${evidencePattern})\\b`).test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDocsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.startsWith("docs/") || lower.endsWith(".md") || lower.endsWith(".mdx") || lower === "readme.md" || lower === "changelog.md";
}

function isUnityPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith("assets/") ||
    lower.startsWith("projectsettings/") ||
    lower.endsWith(".cs") ||
    lower.endsWith(".unity") ||
    lower.endsWith(".prefab") ||
    lower.endsWith(".asset")
  );
}

function isTypeScriptOrWebPath(path: string): boolean {
  const lower = path.toLowerCase();
  const basename = lower.split("/").pop() ?? lower;
  return (
    lower.startsWith("src/") ||
    lower.startsWith("app/") ||
    lower.startsWith("pages/") ||
    lower.startsWith("components/") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    basename === "package.json" ||
    basename === "package-lock.json" ||
    basename === "pnpm-lock.yaml" ||
    basename === "yarn.lock" ||
    basename === "bun.lock" ||
    basename === "tsconfig.json" ||
    basename.startsWith("tsconfig.")
  );
}

function isWorkflowOrReleasePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith(".github/workflows/") ||
    lower.startsWith("docs/releases/") ||
    lower.startsWith("launchd/") ||
    lower.startsWith("config/launchd/") ||
    lower.endsWith(".plist") ||
    lower === "package.json"
  );
}

function isWorldOsRepo(repo: string): boolean {
  return canonicalRepo(repo).endsWith("/worldos") || canonicalRepo(repo).endsWith("/worldos-unity");
}

function canonicalRepo(repo: string): string {
  return repo.toLowerCase();
}
