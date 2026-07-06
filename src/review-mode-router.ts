import { createHash } from "node:crypto";
import type { BotConfig } from "./config.js";
import type { ResolvedRepoProfile } from "./repo-policy.js";
import { buildChangedSurfaceValidationReport } from "./validation-selector.js";
import type {
  ReviewMode,
  ReviewModeAnalysisPlan,
  ReviewModeRoutingRule,
  ReviewModeSelection,
  ReviewModesConfig
} from "./review-mode-types.js";
import type {
  ChangedSurfaceValidationReport,
  PullFilePatch,
  PullRequestSummary,
  RegressionCategory,
  ValidationRecommendation
} from "./types.js";

export interface ReviewModeSelectionInput {
  config: BotConfig;
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  profile?: ResolvedRepoProfile;
  /** Explicit per-repo mode override (repo profile). Highest precedence when present. */
  repoOverrideMode?: ReviewMode;
}

/**
 * Map a required-validation recommendation (from buildChangedSurfaceValidationReport — the shipped
 * #301/#286 classifier, NOT a re-invented path regex set) onto a regression category. This is the
 * ONLY place static surface classes become categories; the recommendation ids are stable and owned
 * by validation-selector.ts, so the router never grows its own path regexes (that was the #274 bug).
 */
const RECOMMENDATION_CATEGORY: Record<string, RegressionCategory> = {
  unity_editor_smoke: "unity_scene_prefab",
  typescript_build: "runtime_correctness",
  ci_release_smoke: "ci_build",
  bot_focused_tests: "runtime_correctness"
};

/**
 * Select a review mode for a PR. Returns undefined when the feature is absent or disabled — the
 * caller then behaves byte-identically and writes ZERO review-mode evidence (the #274 bug this
 * rebuild fixes: it recorded evidence even when disabled). A mode selects analysis depth and spend
 * ONLY; posting behavior is provably unaffected (nothing here feeds the review gate).
 */
export function selectReviewMode(input: ReviewModeSelectionInput): ReviewModeSelection | undefined {
  const config = input.config.reviewModes;
  if (!config || !config.enabled) return undefined;

  const report = buildChangedSurfaceValidationReport({
    repo: input.repo,
    pull: input.pull,
    files: input.files,
    profile: input.profile
  });

  const surfaceCategories = surfaceCategoriesFromReport(report);
  const docsOnly = report.docsOnly;
  const elevatedSurface = report.recommendations.some((recommendation) => recommendation.status === "required");

  // Config-promoted precision (honestly named): the categories the operator has attached a
  // calibration precision-FLOOR to via reviewGate.categoryPrecisionFloors. Key-presence means "the
  // operator flagged this category for calibrated scrutiny" — NOT "measured low precision" (the floor
  // is a confidence threshold; a high floor does not imply low precision). CONFIG ONLY — nothing
  // reads the live calibration aggregate at review time (PR-C invariant), so presence-of-floor is the
  // only signal available and we route floor-calibrated surfaces deeper.
  const floorCalibratedCategories = Object.keys(input.config.reviewGate?.categoryPrecisionFloors ?? {});
  const configPromotedPrecision = surfaceCategories.filter((category) => floorCalibratedCategories.includes(category));

  const routing = config.routing ?? {};
  const reasons: string[] = [];
  let mode: ReviewMode;
  let matchedRule: ReviewModeRoutingRule;

  // Deterministic first-match (total-order) precedence; ties impossible by ordering:
  //   repo_override > docsOnly > floorCalibratedCategories > elevatedSurfaces > default.
  // floorCalibratedCategories is checked BEFORE elevatedSurfaces by design: an operator-flagged
  // (floor-calibrated) surface earns the deeper route even when it would also match the broader
  // elevated-surface rule, so the more specific operator signal wins. This shadowing is intentional.
  if (input.repoOverrideMode !== undefined) {
    mode = input.repoOverrideMode;
    matchedRule = "repo_override";
    reasons.push(`Repo profile pinned review mode "${mode}".`);
  } else if (docsOnly && routing.docsOnly !== undefined) {
    mode = routing.docsOnly;
    matchedRule = "docs_only";
    reasons.push(`Changed surface is docs/metadata only; routing.docsOnly selects "${mode}".`);
  } else if (configPromotedPrecision.length > 0 && routing.floorCalibratedCategories !== undefined) {
    mode = routing.floorCalibratedCategories;
    matchedRule = "floor_calibrated_categories";
    reasons.push(
      `Changed-surface categories ${configPromotedPrecision.join(", ")} have an operator-attached calibration precision-floor (configPromotedPrecision); routing.floorCalibratedCategories selects "${mode}".`
    );
  } else if (elevatedSurface && routing.elevatedSurfaces !== undefined) {
    mode = routing.elevatedSurfaces;
    matchedRule = "elevated_surfaces";
    reasons.push(`Changed surface has a required-validation recommendation (elevated); routing.elevatedSurfaces selects "${mode}".`);
  } else {
    mode = config.defaultMode;
    matchedRule = "default";
    reasons.push(`No routing rule matched; defaultMode "${mode}" selected.`);
  }

  const analysisPlan = resolveAnalysisPlan(mode, input.config);

  return {
    mode,
    matchedRule,
    surface: { docsOnly, elevatedSurface, surfaceCategories },
    configPromotedPrecision,
    analysisPlan,
    configHash: hashConfig(config),
    reasons
  };
}

/**
 * Resolve the demote-only analysis plan a mode implies. Every field is `baseSetting && modeAllows`:
 * a mode can force a stage OFF (modeAllows false) but can NEVER enable a stage the base config has
 * disabled. This is enforced structurally here (logical AND) and, defensively, at config load.
 */
export function resolveAnalysisPlan(mode: ReviewMode, config: BotConfig): ReviewModeAnalysisPlan {
  const definition = config.reviewModes?.modes[mode] ?? {};
  const baseSelfConsistency = config.reviewGate?.selfConsistency?.enabled ?? false;
  const baseGitnexus = config.gitnexusContext?.enabled ?? false;
  const baseGithubRelated = config.githubRelatedContext?.enabled ?? false;

  // `definition.selfConsistency !== false` means "inherit base" (absent or true); === false demotes.
  const selfConsistencyAllowed = definition.selfConsistency !== false;
  const contextAddonsAllowed = definition.contextAddons !== false;

  return {
    selfConsistency: baseSelfConsistency && selfConsistencyAllowed,
    gitnexusContext: baseGitnexus && contextAddonsAllowed,
    githubRelatedContext: baseGithubRelated && contextAddonsAllowed,
    ...(definition.targetMinutes !== undefined ? { targetMinutes: definition.targetMinutes } : {})
  };
}

function surfaceCategoriesFromReport(report: ChangedSurfaceValidationReport): RegressionCategory[] {
  const categories = new Set<RegressionCategory>();
  for (const recommendation of report.recommendations) {
    if (recommendation.status !== "required") continue;
    const category = categoryForRecommendation(recommendation);
    if (category) categories.add(category);
  }
  return [...categories].sort();
}

function categoryForRecommendation(recommendation: ValidationRecommendation): RegressionCategory | undefined {
  return RECOMMENDATION_CATEGORY[recommendation.id];
}

/** Stable, order-independent hash of the reviewModes config for replayable evidence. */
function hashConfig(config: ReviewModesConfig): string {
  return createHash("sha256").update(stableStringify(config)).digest("hex").slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
