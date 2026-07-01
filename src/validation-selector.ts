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
  if (recommendation.id === "unity_editor_smoke") return /play\s*mode|playmode|unity editor|scene smoke|prefab smoke|recording|screenshot/.test(normalized);
  if (recommendation.id === "typescript_build") return /npm run build|pnpm build|typecheck|tsc|vitest|jest|checks? green|ci passed|build passed/.test(normalized);
  if (recommendation.id === "ci_release_smoke") return /release:status|coverage-audit|provider-cooldown|rollback|checks? green|ci passed|github actions/.test(normalized);
  if (recommendation.id === "bot_focused_tests") return /vitest|npm run build|release:status|coverage-audit|focused test/.test(normalized);
  return recommendation.proofTypes.some((proofType) => normalized.includes(proofType.toLowerCase()));
}

function detectEvidenceMentions(text: string): string[] {
  const normalized = text.toLowerCase();
  const evidence = new Set<string>();
  if (/play\s*mode|playmode|unity editor/.test(normalized)) evidence.add("Unity smoke");
  if (/screenshot|recording/.test(normalized)) evidence.add("visual proof");
  if (/npm run build|pnpm build|typecheck|tsc/.test(normalized)) evidence.add("build/typecheck");
  if (/vitest|jest|test passed|focused test/.test(normalized)) evidence.add("tests");
  if (/checks? green|ci passed|github actions/.test(normalized)) evidence.add("CI checks");
  if (/release:status|coverage-audit|provider-cooldown/.test(normalized)) evidence.add("release/operator checks");
  return [...evidence];
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
  return (
    lower.startsWith("src/") ||
    lower.startsWith("app/") ||
    lower.startsWith("pages/") ||
    lower.startsWith("components/") ||
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower === "package.json" ||
    lower === "package-lock.json" ||
    lower === "pnpm-lock.yaml" ||
    lower === "tsconfig.json" ||
    lower.startsWith("tsconfig.")
  );
}

function isWorkflowOrReleasePath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith(".github/workflows/") ||
    lower.startsWith("docs/releases/") ||
    lower.includes("launchd") ||
    lower.includes("release") ||
    lower === "package.json"
  );
}

function isWorldOsRepo(repo: string): boolean {
  return canonicalRepo(repo).endsWith("/worldos") || canonicalRepo(repo).endsWith("/worldos-unity");
}

function canonicalRepo(repo: string): string {
  return repo.toLowerCase();
}
