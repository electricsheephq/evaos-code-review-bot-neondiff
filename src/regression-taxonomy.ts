import type { Finding, RegressionCategory, ReviewComment, Severity } from "./types.js";

export const REGRESSION_CATEGORIES: RegressionCategory[] = [
  "data_loss",
  "auth",
  "ci_build",
  "unity_scene_prefab",
  "security_boundary",
  "migration",
  "api_compatibility",
  "release_regression",
  "flaky_test_risk",
  "proof_gap",
  "runtime_correctness",
  "dependency",
  "docs_only",
  "unknown"
];

export interface RegressionCategoryPolicy {
  label: string;
  requestChangesEligible: boolean;
}

export const REGRESSION_CATEGORY_POLICY: Record<RegressionCategory, RegressionCategoryPolicy> = {
  data_loss: { label: "Data loss", requestChangesEligible: true },
  auth: { label: "Auth", requestChangesEligible: true },
  ci_build: { label: "CI/build", requestChangesEligible: true },
  unity_scene_prefab: { label: "Unity scene/prefab", requestChangesEligible: true },
  security_boundary: { label: "Security boundary", requestChangesEligible: true },
  migration: { label: "Migration", requestChangesEligible: true },
  api_compatibility: { label: "API compatibility", requestChangesEligible: true },
  release_regression: { label: "Release regression", requestChangesEligible: true },
  flaky_test_risk: { label: "Flaky test risk", requestChangesEligible: true },
  proof_gap: { label: "Proof gap", requestChangesEligible: false },
  runtime_correctness: { label: "Runtime correctness", requestChangesEligible: true },
  dependency: { label: "Dependency", requestChangesEligible: true },
  docs_only: { label: "Docs only", requestChangesEligible: false },
  unknown: { label: "Uncategorized", requestChangesEligible: true }
};

export function isRegressionCategory(value: unknown): value is RegressionCategory {
  return typeof value === "string" && (REGRESSION_CATEGORIES as string[]).includes(value);
}

export function categoryLabel(category: RegressionCategory): string {
  return REGRESSION_CATEGORY_POLICY[category].label;
}

export function isRequestChangesEligible(input: Pick<ReviewComment, "severity" | "category">): boolean {
  return isHighSeverity(input.severity) && REGRESSION_CATEGORY_POLICY[input.category].requestChangesEligible;
}

export function isHighSeverity(severity: Severity): boolean {
  return severity === "P0" || severity === "P1";
}

export function normalizeFindingCategory(finding: Finding): RegressionCategory {
  return finding.category ?? inferRegressionCategory(finding);
}

export function countCategories(comments: Pick<ReviewComment, "category">[]): Partial<Record<RegressionCategory, number>> {
  const counts: Partial<Record<RegressionCategory, number>> = {};
  for (const comment of comments) counts[comment.category] = (counts[comment.category] ?? 0) + 1;
  return counts;
}

export function inferRegressionCategory(finding: Pick<Finding, "path" | "title" | "body" | "why_this_matters">): RegressionCategory {
  const haystack = `${finding.path}\n${finding.title}\n${finding.body}\n${finding.why_this_matters ?? ""}`.toLowerCase();
  const path = finding.path.toLowerCase();

  if (
    matchesAny(haystack, ["data loss", "overwrite", "clobber", "truncate", "corrupt"]) ||
    (matchesAny(haystack, ["rollback"]) && matchesAny(haystack, ["save", "state", "database", "customer data"]))
  ) {
    return "data_loss";
  }
  if (matchesAny(haystack, ["secret", "credential", "private key", "cookie", "xss", "csrf", "ssrf", "injection"])) {
    return "security_boundary";
  }
  if (matchesAny(haystack, ["auth", "permission", "unauthorized", "oauth", "session", "login", "token"])) {
    return "auth";
  }
  if (matchesAny(path, [".github/workflows/", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig"])) {
    return "ci_build";
  }
  if (matchesAny(path, ["assets/", "projectsettings/", ".unity", ".prefab", ".asset", ".cs"])) {
    return "unity_scene_prefab";
  }
  if (matchesAny(haystack, ["migration", "schema", "database", "backfill"])) {
    return "migration";
  }
  if (matchesAny(haystack, ["api", "contract", "compatibility", "breaking change", "payload"])) {
    return "api_compatibility";
  }
  if (matchesAny(haystack, ["release", "deploy", "launchd", "notar", "rollback", "appcast", "production"])) {
    return "release_regression";
  }
  if (matchesAny(haystack, ["flaky", "race", "timeout", "non-deterministic", "nondeterministic"])) {
    return "flaky_test_risk";
  }
  if (matchesAny(haystack, ["proof", "evidence", "screenshot", "recording", "smoke", "play mode", "playmode"])) {
    return "proof_gap";
  }
  if (matchesAny(path, ["docs/", ".md", ".mdx"])) return "docs_only";
  if (matchesAny(path, ["src/", "app/", "lib/", "server/", "client/"])) return "runtime_correctness";
  if (matchesAny(path, ["requirements", "poetry.lock", "cargo.lock", "go.sum", "bun.lock"])) return "dependency";
  return "unknown";
}

function matchesAny(text: string, needles: string[]): boolean {
  return needles.some((needle) => {
    if (/[\s/.*_-]/.test(needle)) return text.includes(needle);
    return new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`).test(text);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
