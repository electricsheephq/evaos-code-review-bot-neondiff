import type { RegressionCategory } from "./types.js";

/**
 * Review mode router (#266). A review mode selects ANALYSIS DEPTH AND SPEND ONLY: budget knobs,
 * whether the selfConsistency re-check runs, and which context add-ons are consulted. It NEVER
 * changes posting behavior — the deterministic review gate, caps, floors, REQUEST_CHANGES
 * eligibility, and redaction run identically for every mode. Modes may only DEMOTE from base config
 * (a mode can turn selfConsistency OFF for "light" but can never turn it ON when the base config has
 * it off). This is the quieter-only invariant's analog for routing, and it is what makes the feature
 * safe to ship default-off. See src/review-mode-router.ts and the #266 spec.
 */
export type ReviewMode = "light" | "standard" | "deep";

/** Which precedence rule selected the mode (evidence, deterministic, redaction-safe). */
export type ReviewModeRoutingRule =
  | "repo_override"
  | "docs_only"
  | "floor_calibrated_categories"
  | "elevated_surfaces"
  | "default";

/** Per-mode analysis-depth knobs. All fields are DEMOTE-ONLY relative to base config. */
export interface ReviewModeDefinition {
  /**
   * When false, force the selfConsistency re-check off for this mode even if base config enables it.
   * When true (or absent), inherit the base config's selfConsistency setting. A mode can never turn
   * selfConsistency ON when base has it off — validation rejects that at load.
   */
  selfConsistency?: boolean;
  /**
   * When false, force gitnexus/github-related context add-ons off for this mode even if base config
   * enables them. When true (or absent), inherit the base config's add-on settings. Demote-only.
   */
  contextAddons?: boolean;
  /** Advisory target-minutes for this mode (evidence only; never consumed by posting or scheduling). */
  targetMinutes?: number;
}

/** Routing table: which mode each static/config-promoted signal class maps to. */
export interface ReviewModeRouting {
  /** Mode for a docs-only changed surface. */
  docsOnly?: ReviewMode;
  /** Mode for an elevated changed surface (any required-validation recommendation). */
  elevatedSurfaces?: ReviewMode;
  /**
   * Mode when a changed-surface category has an operator-attached calibration precision-floor
   * (reviewGate.categoryPrecisionFloors). Presence of a floor means the operator flagged that category
   * for calibrated scrutiny — NOT that its precision was measured low (the floor is a confidence
   * threshold). Nothing reads the live aggregate at review time, so presence-of-floor is the signal.
   */
  floorCalibratedCategories?: ReviewMode;
}

/** The `reviewModes` config block (#266). Absent ⇒ byte-identical behavior + zero evidence writes. */
export interface ReviewModesConfig {
  /** When false (default), the router is a no-op: byte-identical behavior, zero evidence writes. */
  enabled: boolean;
  /** Mode used when no routing rule matches. */
  defaultMode: ReviewMode;
  /** Per-mode analysis-depth definitions. Every mode key must be present. */
  modes: Record<ReviewMode, ReviewModeDefinition>;
  /** Signal-to-mode routing table. */
  routing?: ReviewModeRouting;
}

/**
 * The resolved analysis plan a mode implies, relative to the base config. Every field is a
 * demote-only projection of the base setting: `false` means "forced off by mode", the base value
 * otherwise. Nothing here can enable an analysis stage the base config has disabled.
 */
export interface ReviewModeAnalysisPlan {
  /** Effective selfConsistency after applying the mode's demote-only knob to the base setting. */
  selfConsistency: boolean;
  /** Effective gitnexus context add-on after the mode's demote-only knob. */
  gitnexusContext: boolean;
  /** Effective github-related context add-on after the mode's demote-only knob. */
  githubRelatedContext: boolean;
  /** Advisory target-minutes for this mode (evidence only). */
  targetMinutes?: number;
}

/**
 * A single route decision, recorded in run evidence (redacted writers). Deterministic and replayable
 * from the input signals + config hash. Written ONLY when reviewModes.enabled is true.
 */
export interface ReviewModeSelection {
  mode: ReviewMode;
  /** Which precedence rule fired. */
  matchedRule: ReviewModeRoutingRule;
  /** Static-surface inputs to the decision. */
  surface: {
    docsOnly: boolean;
    elevatedSurface: boolean;
    /** Changed-surface regression categories derived from the required recommendations. */
    surfaceCategories: RegressionCategory[];
  };
  /**
   * Config-promoted precision signal (the calibration-informed weight). These are the changed-surface
   * categories to which the operator has attached a calibration precision-FLOOR via
   * reviewGate.categoryPrecisionFloors — i.e. categories the operator flagged for calibrated scrutiny.
   * Presence of a floor is the signal (NOT a measured-low-precision value; the floor is a confidence
   * threshold). Read from CONFIG ONLY — nothing reads the live calibration aggregate at review time.
   * The phrase "outcome-weighted" appears nowhere: this is config-promoted, not live-aggregated.
   */
  configPromotedPrecision: RegressionCategory[];
  /** The resolved demote-only analysis plan the mode implies. */
  analysisPlan: ReviewModeAnalysisPlan;
  /** Stable hash of the reviewModes config that produced this decision (replayability). */
  configHash: string;
  /** Human-readable, redaction-safe reasons. */
  reasons: string[];
}
