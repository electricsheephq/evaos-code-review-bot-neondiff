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

/** Optional per-severity confidence floors for REQUEST_CHANGES eligibility (default off). */
export interface RequestChangesConfidenceFloors {
  P0?: number;
  P1?: number;
}

/** Optional per-category confidence floors (#286 PR C), operator-curated from the aggregate
 * calibration report. A finding in a listed category loses REQUEST_CHANGES eligibility when its
 * confidence is BELOW the category's floor (value 0..1). The value is load-bearing: {cat: 0} never
 * demotes, {cat: 1} demotes everything below confidence 1.0. Quieter-only — it can only demote. */
export type CategoryPrecisionFloors = Partial<Record<RegressionCategory, number>>;

export function isRequestChangesEligible(
  input: Pick<ReviewComment, "severity" | "category" | "confidence">,
  confidenceFloors?: RequestChangesConfidenceFloors,
  categoryPrecisionFloors?: CategoryPrecisionFloors
): boolean {
  if (!isHighSeverity(input.severity) || !REGRESSION_CATEGORY_POLICY[input.category].requestChangesEligible) {
    return false;
  }
  // Category precision floor (#286 PR C, quieter-only): a finding whose category is configured with a
  // floor loses REQUEST_CHANGES eligibility only when its confidence is BELOW that floor. The value is
  // load-bearing ({cat: 0} never demotes, {cat: 1} demotes everything below 1.0). The finding still
  // POSTS as a comment; only the event is demoted. Floors are operator-curated from the aggregate
  // report — nothing is read at review time.
  const categoryFloor = categoryPrecisionFloors?.[input.category];
  if (typeof categoryFloor === "number" && input.confidence < categoryFloor) return false;
  const floor = confidenceFloors?.[input.severity as "P0" | "P1"];
  // A configured floor may only make the gate quieter: below-floor findings stop counting toward
  // REQUEST_CHANGES but still post as comments. When unset, behavior is byte-identical to before.
  if (typeof floor === "number" && input.confidence < floor) return false;
  return true;
}

export function isHighSeverity(severity: Severity): boolean {
  return severity === "P0" || severity === "P1";
}

export function normalizeFindingCategory(finding: Finding): RegressionCategory {
  // Asymmetric precedence (#280): the model's validated category wins whenever it is present and
  // != "unknown", with ONE exception — inference may override only when it ESCALATES across the
  // REQUEST_CHANGES eligibility boundary (model category RC-ineligible, inferred category RC-eligible
  // and != "unknown"). This is an escalate-only safety net: it never de-escalates a model category
  // and never relabels within the same eligibility tier (the incidental-"token" bug #280 verified).
  // Absent or "unknown" model category falls through to inference as before. The first-match-wins
  // chain in inferRegressionCategory is a deliberate risk-priority arbiter (scoring was evaluated
  // and dropped after it misclassified security findings on the overlapping needle substrate).
  const inferred = inferRegressionCategory(finding);
  if (finding.category && finding.category !== "unknown") {
    const modelEligible = REGRESSION_CATEGORY_POLICY[finding.category].requestChangesEligible;
    const inferredEligible = inferred !== "unknown" && REGRESSION_CATEGORY_POLICY[inferred].requestChangesEligible;
    if (!modelEligible && inferredEligible) return inferred;
    return finding.category;
  }
  return inferred;
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
  if (matchesAny(haystack, ["secret", "credential", "private key", "api key", "access token", "leaked token", "cookie", "xss", "csrf", "ssrf", "injection"])) {
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
