import type { ReviewMode, ReviewModeBudget, ReviewModeBudgetDisposition, ReviewModesConfig, ReviewModeSelection } from "./review-mode-types.js";
import type { PullFilePatch, PullRequestSummary, RegressionCategory } from "./types.js";

export interface ReviewModeSelectionInput {
  subject: "pull_request" | "issue";
  pull?: PullRequestSummary;
  files?: PullFilePatch[];
  labels?: string[];
  title?: string;
  body?: string | null;
  docsOnly?: boolean;
  expectedRuntimeMs?: number;
  providerTimeoutMs?: number;
  reviewModes?: ReviewModesConfig;
  researchRequested?: boolean;
}

const MODE_BUDGETS: Record<ReviewMode, { targetMinutes: number; hardTimeoutMinutes: number }> = {
  fast: { targetMinutes: 5, hardTimeoutMinutes: 10 },
  standard: { targetMinutes: 15, hardTimeoutMinutes: 20 },
  deep: { targetMinutes: 25, hardTimeoutMinutes: 35 },
  product_pm: { targetMinutes: 15, hardTimeoutMinutes: 25 },
  research: { targetMinutes: 20, hardTimeoutMinutes: 30 }
};

const PATH_TOKEN_BOUNDARY = "([/._-]|$)";

const DEEP_PATH_PATTERNS: Array<{ pattern: RegExp; area: RegressionCategory; signal: string }> = [
  { pattern: new RegExp(`(^|/)(auth|oauth|session|token|permission|entitlement)s?${PATH_TOKEN_BOUNDARY}`, "i"), area: "auth", signal: "auth/security path" },
  { pattern: new RegExp(`(^|/)(security|secrets?|credential|keychain)${PATH_TOKEN_BOUNDARY}`, "i"), area: "security_boundary", signal: "security boundary path" },
  { pattern: new RegExp(`(^|/)(migration|migrations|schema|database|sqlite|postgres)${PATH_TOKEN_BOUNDARY}`, "i"), area: "migration", signal: "migration/data path" },
  { pattern: new RegExp(`(^|/)(release|launchd|daemon|scheduler|worker|queue|provider|zcode|state)${PATH_TOKEN_BOUNDARY}`, "i"), area: "runtime_correctness", signal: "runtime/provider path" },
  { pattern: new RegExp(`(^|/)(ci|workflow|workflows|build|deploy)${PATH_TOKEN_BOUNDARY}|\\.github/workflows/`, "i"), area: "ci_build", signal: "CI/release path" },
  { pattern: /\.(unity|prefab|asset|scene)$/i, area: "unity_scene_prefab", signal: "Unity scene/prefab asset" },
  { pattern: /(^|\/)(pricing|billing|payments?|stripe)([/.]|$)/i, area: "api_compatibility", signal: "billing/pricing path" }
];

const PRODUCT_TEXT_PATTERNS = [
  /\b(ux|ui|onboarding|pricing|roadmap|product|conversion|activation|retention|copy|funnel|checkout)\b/i,
  /\b(user experience|landing page|marketing|website|dashboard|settings|workflow)\b/i
];

const DOC_PATH_PATTERN = /(^|\/)(docs?|readme|changelog|code_of_conduct|license)([/.]|$)|(^|\/)security\.(md|mdx|txt|rst)$|\.(md|mdx|txt|rst)$/i;

export function selectReviewMode(input: ReviewModeSelectionInput): ReviewModeSelection {
  const files = input.files ?? [];
  const labels = normalizeLabels(input.labels ?? input.pull?.labels?.map((label) => label.name) ?? []);
  const title = input.title ?? input.pull?.title ?? "";
  const body = input.body ?? input.pull?.body ?? "";
  const text = `${title}\n${body}\n${labels.join("\n")}`;
  const reasons: string[] = [];
  const matchedSignals = new Set<string>();
  const riskAreas = new Set<RegressionCategory>();

  if (input.subject === "issue" && !input.researchRequested) {
    reasons.push("Issue-shaped input did not explicitly request research mode; issue enrichment routing stays opt-in.");
    matchedSignals.add("issue_research_not_requested");
    return buildSelection("standard", "issue_enrichment", 0.64, reasons, matchedSignals, riskAreas, input.expectedRuntimeMs, input.providerTimeoutMs, input.reviewModes);
  }

  if (input.subject === "issue" && input.researchRequested) {
    reasons.push("Issue enrichment explicitly requested research/build-vs-buy mode.");
    matchedSignals.add("research_requested");
    return buildSelection("research", "issue_enrichment", 0.86, reasons, matchedSignals, riskAreas, input.expectedRuntimeMs, input.providerTimeoutMs, input.reviewModes);
  }

  const docsOnly = input.docsOnly ?? (files.length > 0 && files.every((file) => isDocsOnlyPath(file.filename)));
  if (docsOnly) {
    reasons.push("Changed surface is docs/metadata only, so deep review would likely waste GLM time.");
    matchedSignals.add("docs_only_surface");
    riskAreas.add("docs_only");
    recordDocsOnlySignals(files, text, matchedSignals, riskAreas);
    return buildSelection("fast", "pull_request_review", 0.9, reasons, matchedSignals, riskAreas, input.expectedRuntimeMs, input.providerTimeoutMs, input.reviewModes);
  }

  const deep = hasDeepSignal(files, matchedSignals, riskAreas) || hasDeepTextSignal(text, matchedSignals, riskAreas);
  if (deep) {
    reasons.push("High-risk runtime/security/release/data/Unity/provider signal requires deeper regression review.");
    return buildSelection("deep", "pull_request_review", 0.82, reasons, matchedSignals, riskAreas, input.expectedRuntimeMs, input.providerTimeoutMs, input.reviewModes);
  }

  if (hasProductSignal(text)) {
    reasons.push("Product, UX, pricing, onboarding, or roadmap signal should use product/PM review criteria.");
    matchedSignals.add("product_pm_text");
    return buildSelection("product_pm", "pull_request_review", 0.78, reasons, matchedSignals, riskAreas, input.expectedRuntimeMs, input.providerTimeoutMs, input.reviewModes);
  }

  reasons.push("No fast-path, deep-risk, or product/PM trigger matched; use normal code review depth.");
  matchedSignals.add("default_standard");
  return buildSelection("standard", "pull_request_review", 0.7, reasons, matchedSignals, riskAreas, input.expectedRuntimeMs, input.providerTimeoutMs, input.reviewModes);
}

function buildSelection(
  mode: ReviewMode,
  targetUse: ReviewModeSelection["targetUse"],
  confidence: number,
  reasons: string[],
  matchedSignals: Set<string>,
  riskAreas: Set<RegressionCategory>,
  expectedRuntimeMs?: number,
  providerTimeoutMs?: number,
  reviewModes?: ReviewModesConfig
): ReviewModeSelection {
  return {
    mode,
    targetUse,
    confidence,
    outcomeWeights: outcomeWeightsForMode(mode),
    reasons,
    matchedSignals: [...matchedSignals].sort(),
    riskAreas: [...riskAreas].sort(),
    budget: buildBudget(mode, expectedRuntimeMs, providerTimeoutMs, reviewModes),
    proofBoundary: "Review mode routing is evidence-only in this release. It records the cheapest useful intended depth and budget target, but does not change scheduler concurrency, ZCode timeout, posting policy, or live runtime behavior."
  };
}

function outcomeWeightsForMode(mode: ReviewMode): ReviewModeSelection["outcomeWeights"] {
  if (mode === "fast") {
    return {
      regressionPrevention: 10,
      signalToNoise: 30,
      latencyFlow: 30,
      contextProofAwareness: 10,
      glmCostEfficiency: 15,
      safetyLifecycle: 5
    };
  }
  if (mode === "deep") {
    return {
      regressionPrevention: 35,
      signalToNoise: 15,
      latencyFlow: 10,
      contextProofAwareness: 20,
      glmCostEfficiency: 10,
      safetyLifecycle: 10
    };
  }
  if (mode === "product_pm") {
    return {
      regressionPrevention: 15,
      signalToNoise: 20,
      latencyFlow: 20,
      contextProofAwareness: 25,
      glmCostEfficiency: 10,
      safetyLifecycle: 10
    };
  }
  if (mode === "research") {
    return {
      regressionPrevention: 10,
      signalToNoise: 15,
      latencyFlow: 15,
      contextProofAwareness: 30,
      glmCostEfficiency: 15,
      safetyLifecycle: 15
    };
  }
  return {
    regressionPrevention: 30,
    signalToNoise: 20,
    latencyFlow: 20,
    contextProofAwareness: 15,
    glmCostEfficiency: 10,
    safetyLifecycle: 5
  };
}

function buildBudget(mode: ReviewMode, expectedRuntimeMs?: number, providerTimeoutMs?: number, reviewModes?: ReviewModesConfig): ReviewModeBudget {
  const fallback = MODE_BUDGETS[mode];
  const configured = reviewModes?.modes[mode];
  const targetMinutes = configured?.targetMinutes ?? fallback.targetMinutes;
  const targetMs = targetMinutes * 60_000;
  const hardTimeoutMs = configured?.wholeRunDeadlineMs ?? fallback.hardTimeoutMinutes * 60_000;
  const hardTimeoutMinutes = Math.max(1, Math.floor(hardTimeoutMs / 60_000));
  if (providerTimeoutMs !== undefined && providerTimeoutMs < targetMs) {
    const disposition: ReviewModeBudgetDisposition = mode === "fast" ? "timeout_risk" : "partial";
    return {
      targetMinutes,
      targetMs,
      hardTimeoutMinutes,
      hardTimeoutMs,
      disposition,
      detail: `Configured provider timeout ${providerTimeoutMs}ms is below the ${targetMinutes} minute mode target; evidence must treat this route as ${disposition} unless timeout is raised or review depth is cut.`
    };
  }
  if (providerTimeoutMs !== undefined && providerTimeoutMs < hardTimeoutMs) {
    return {
      targetMinutes,
      targetMs,
      hardTimeoutMinutes,
      hardTimeoutMs,
      disposition: "timeout_risk",
      detail: `Configured provider timeout ${providerTimeoutMs}ms is below the ${hardTimeoutMinutes} minute hard timeout; route can start but may need partial/deferred handling if GLM runs long.`
    };
  }
  if (expectedRuntimeMs === undefined) {
    return {
      targetMinutes,
      targetMs,
      hardTimeoutMinutes,
      hardTimeoutMs,
      disposition: "within_budget",
      detail: "No observed runtime supplied; route records target budget only."
    };
  }
  if (expectedRuntimeMs <= targetMs) {
    return {
      targetMinutes,
      targetMs,
      hardTimeoutMinutes,
      hardTimeoutMs,
      disposition: "within_budget",
      detail: `Observed or expected runtime ${expectedRuntimeMs}ms is within the ${targetMinutes} minute target.`
    };
  }
  if (expectedRuntimeMs <= hardTimeoutMs) {
    return {
      targetMinutes,
      targetMs,
      hardTimeoutMinutes,
      hardTimeoutMs,
      disposition: "partial",
      detail: `Observed or expected runtime ${expectedRuntimeMs}ms exceeds target but is below hard timeout; reviewer output should be marked partial if depth is cut short.`
    };
  }
  return {
    targetMinutes,
    targetMs,
    hardTimeoutMinutes,
    hardTimeoutMs,
    disposition: mode === "deep" || mode === "research" ? "deferred" : "timeout_risk",
    detail: `Observed or expected runtime ${expectedRuntimeMs}ms exceeds hard timeout; route should defer or mark timeout rather than silently blocking queue progress.`
  };
}

function hasDeepSignal(files: PullFilePatch[], matchedSignals: Set<string>, riskAreas: Set<RegressionCategory>): boolean {
  let matched = false;
  for (const file of files) {
    for (const entry of DEEP_PATH_PATTERNS) {
      if (entry.pattern.test(file.filename)) {
        matched = true;
        matchedSignals.add(entry.signal);
        riskAreas.add(entry.area);
      }
    }
    const churn = file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0);
    if (churn >= 500) {
      matched = true;
      matchedSignals.add("high_churn_file");
      riskAreas.add("release_regression");
    }
  }
  return matched;
}

function hasDeepTextSignal(text: string, matchedSignals: Set<string>, riskAreas: Set<RegressionCategory>): boolean {
  const patterns: Array<{ pattern: RegExp; area: RegressionCategory; signal: string }> = [
    { pattern: /\b(auth|permission|data loss|migration|zcode|glm)\b/i, area: "runtime_correctness", signal: "deep_text" },
    { pattern: /\b(security boundary|security disclosure|vulnerability|credential leak|secret leak)\b/i, area: "security_boundary", signal: "security_text" },
    { pattern: /\b(release blocker|release regression|release gate|runtime crash|runtime failure|provider outage|provider throttle|provider overload|queue stuck|queue backlog|scheduler deadlock|scheduler lease)\b/i, area: "runtime_correctness", signal: "corroborated_runtime_text" },
    { pattern: /\b(unity|scene|prefab|save state|save-state)\b/i, area: "unity_scene_prefab", signal: "unity_text" }
  ];
  let matched = false;
  for (const entry of patterns) {
    if (entry.pattern.test(text)) {
      matched = true;
      matchedSignals.add(entry.signal);
      riskAreas.add(entry.area);
    }
  }
  return matched;
}

function recordDocsOnlySignals(files: PullFilePatch[], text: string, matchedSignals: Set<string>, riskAreas: Set<RegressionCategory>): void {
  const docsRiskAreas = new Set<RegressionCategory>();
  const docsSignals = new Set<string>();
  hasDeepSignal(files, docsSignals, docsRiskAreas);
  for (const signal of docsSignals) matchedSignals.add(`docs_${signal}`);
  for (const area of docsRiskAreas) riskAreas.add(area);
  if (hasProductSignal(text)) {
    matchedSignals.add("docs_product_pm_text");
    riskAreas.add("api_compatibility");
  }
}

function hasProductSignal(text: string): boolean {
  return PRODUCT_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

function isDocsOnlyPath(path: string): boolean {
  return DOC_PATH_PATTERN.test(path);
}

function normalizeLabels(labels: string[]): string[] {
  return labels.map((label) => label.trim().toLowerCase()).filter(Boolean).sort();
}
