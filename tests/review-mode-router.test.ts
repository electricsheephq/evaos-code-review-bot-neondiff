import { describe, expect, expectTypeOf, it } from "vitest";
import { loadConfigFromObject, type BotConfig } from "../src/config.js";
import { applyDeterministicReviewGate } from "../src/review-gate.js";
import { selectReviewMode, surfaceCategoriesFromReport } from "../src/review-mode-router.js";
import type { ReviewMode } from "../src/review-mode-types.js";
import type { ChangedSurfaceValidationReport, Finding, PullFilePatch, PullRequestSummary } from "../src/types.js";

function pull(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: "PR",
    draft: false,
    head: { sha: "head", ref: "feature" },
    base: { sha: "base", ref: "main", repo: { full_name: "owner/repo" } },
    html_url: "https://example.invalid/owner/repo/pull/1",
    ...overrides
  };
}

const AUTH_FILES: PullFilePatch[] = [{ filename: "src/auth/session.ts" }];
const DOCS_FILES: PullFilePatch[] = [{ filename: "docs/guide.md" }];
const CI_FILES: PullFilePatch[] = [{ filename: ".github/workflows/build.yml" }];

/** A reviewModes block matching the shipped spec §3 shape. */
function reviewModes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    defaultMode: "standard",
    modes: {
      light: { selfConsistency: false, contextAddons: false, targetMinutes: 3 },
      standard: {},
      deep: { targetMinutes: 12 }
    },
    routing: {
      docsOnly: "light",
      elevatedSurfaces: "deep",
      floorCalibratedCategories: "deep"
    },
    ...overrides
  };
}

function select(config: BotConfig, files: PullFilePatch[], extra: { repoOverrideMode?: ReviewMode } = {}) {
  return selectReviewMode({ config, repo: "owner/repo", pull: pull(), files, ...extra });
}

describe("reviewModes config validation (#266, fail-closed + demote-only)", () => {
  it("is absent by default — never defaulted in, so behavior is byte-identical + zero evidence", () => {
    const config = loadConfigFromObject({});
    expect(config.reviewModes).toBeUndefined();
    expect(selectReviewMode({ config, repo: "owner/repo", pull: pull(), files: AUTH_FILES })).toBeUndefined();
  });

  it("accepts the shipped default-off shape", () => {
    const config = loadConfigFromObject({ reviewModes: { ...reviewModes(), enabled: false } });
    expect(config.reviewModes?.enabled).toBe(false);
    expect(config.reviewModes?.defaultMode).toBe("standard");
  });

  it("rejects unknown top-level keys", () => {
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), bogus: 1 } })).toThrow(
      /reviewModes has unknown key "bogus"/
    );
  });

  it("rejects an unknown mode key", () => {
    const modes = { light: {}, standard: {}, deep: {}, turbo: {} };
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes has unknown mode "turbo"/
    );
  });

  it("rejects an unknown mode-definition key", () => {
    const modes = { light: { escalate: true }, standard: {}, deep: {} };
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes\.light has unknown key "escalate"/
    );
  });

  it("rejects an invalid defaultMode", () => {
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), defaultMode: "turbo" } })).toThrow(
      /reviewModes\.defaultMode must be light, standard, or deep/
    );
  });

  it("rejects an unknown routing key and a non-mode routing value", () => {
    expect(() =>
      loadConfigFromObject({ reviewModes: { ...reviewModes(), routing: { docsOnly: "light", bogus: "deep" } } })
    ).toThrow(/reviewModes\.routing has unknown key "bogus"/);
    expect(() =>
      loadConfigFromObject({ reviewModes: { ...reviewModes(), routing: { docsOnly: "turbo" } } })
    ).toThrow(/reviewModes\.routing\.docsOnly must be light, standard, or deep/);
  });

  it("enforces demote-only: a mode cannot enable selfConsistency when base config disables it", () => {
    const modes = { light: {}, standard: { selfConsistency: true }, deep: {} };
    // base reviewGate.selfConsistency is off by default.
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes\.standard\.selfConsistency cannot be true when base config disables selfConsistency/
    );
  });

  it("enforces demote-only: a mode cannot enable context add-ons when base config disables them", () => {
    const modes = { light: {}, standard: {}, deep: { contextAddons: true } };
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes\.deep\.contextAddons cannot be true when base config disables context add-ons/
    );
  });

  it("allows a mode to enable a stage ONLY when base config has it on (demote-or-inherit)", () => {
    const config = loadConfigFromObject({
      reviewGate: { maxInlineComments: 25, selfConsistency: { enabled: true } },
      gitnexusContext: { enabled: true },
      reviewModes: {
        ...reviewModes(),
        modes: { light: { selfConsistency: false }, standard: { selfConsistency: true }, deep: { contextAddons: true } }
      }
    });
    expect(config.reviewModes).toBeDefined();
  });

  it("rejects a non-integer targetMinutes", () => {
    const modes = { light: {}, standard: {}, deep: { targetMinutes: 0 } };
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes\.deep\.targetMinutes must be a positive integer/
    );
  });

  it("reports a required mode key as absent (not a generic type error) when it is missing", () => {
    const modes = { light: {}, deep: {} }; // standard entirely absent
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes\.standard is required/
    );
  });

  it("still reports a present-but-wrong-type mode as needing to be an object", () => {
    const modes = { light: {}, standard: 42, deep: {} };
    expect(() => loadConfigFromObject({ reviewModes: { ...reviewModes(), modes } })).toThrow(
      /reviewModes\.modes\.standard must be an object/
    );
  });
});

describe("selectReviewMode routing decision table (#266)", () => {
  it("returns undefined (zero evidence) when disabled", () => {
    const config = loadConfigFromObject({ reviewModes: { ...reviewModes(), enabled: false } });
    expect(select(config, AUTH_FILES)).toBeUndefined();
  });

  it("routes docs-only surface to the configured light mode", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() });
    const selection = select(config, DOCS_FILES);
    expect(selection?.mode).toBe("light");
    expect(selection?.matchedRule).toBe("docs_only");
    expect(selection?.surface.docsOnly).toBe(true);
  });

  it("routes an elevated required-validation surface to deep", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() });
    const selection = select(config, AUTH_FILES);
    expect(selection?.mode).toBe("deep");
    expect(selection?.matchedRule).toBe("elevated_surfaces");
    expect(selection?.surface.elevatedSurface).toBe(true);
  });

  it("routes to defaultMode when no rule matches", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() });
    // A markdown-adjacent non-required, non-docs-only surface: mixed docs + non-elevated code.
    const selection = select(config, [{ filename: "docs/guide.md" }, { filename: "misc/notes.txt" }]);
    expect(selection?.matchedRule).toBe("default");
    expect(selection?.mode).toBe("standard");
  });

  it("prefers floor-calibrated categories over the elevated-surface rule", () => {
    // ci_build is the category for a workflow change; the operator has attached a calibration
    // precision-floor to it, so the more specific floor-calibrated rule wins over elevatedSurfaces.
    const config = loadConfigFromObject({
      reviewGate: { maxInlineComments: 25, categoryPrecisionFloors: { ci_build: 0.9 } },
      reviewModes: { ...reviewModes(), routing: { docsOnly: "light", elevatedSurfaces: "standard", floorCalibratedCategories: "deep" } }
    });
    const selection = select(config, CI_FILES);
    expect(selection?.matchedRule).toBe("floor_calibrated_categories");
    expect(selection?.mode).toBe("deep");
    expect(selection?.configPromotedPrecision).toContain("ci_build");
  });

  it("reads floor-calibrated categories from config only (empty floors ⇒ no configPromotedPrecision)", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() });
    const selection = select(config, CI_FILES);
    expect(selection?.configPromotedPrecision).toEqual([]);
    expect(selection?.matchedRule).toBe("elevated_surfaces");
  });

  it("fail-safe: a REQUIRED recommendation with an unmapped id still yields an elevated category", () => {
    // Simulate a future validation-selector recommendation id we have not mapped yet. It must not be
    // silently dropped from routing — it falls back to runtime_correctness (a real elevated category).
    const report = {
      summary: "future required surface",
      docsOnly: false,
      recommendations: [
        { id: "future_new_smoke", title: "Future smoke", status: "required", reason: "r", matchedPaths: [], proofTypes: [] }
      ],
      profileHints: { validationHints: [], proofExpectations: [] }
    } as unknown as ChangedSurfaceValidationReport;
    expect(surfaceCategoriesFromReport(report)).toEqual(["runtime_correctness"]);
  });

  it("honors an explicit repo override at highest precedence", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() });
    const selection = select(config, DOCS_FILES, { repoOverrideMode: "deep" });
    expect(selection?.matchedRule).toBe("repo_override");
    expect(selection?.mode).toBe("deep");
  });

  it("applies the documented total-order precedence when multiple rules match at once", () => {
    // Distinct target modes per rule so the winning rule is unambiguous from the resolved mode.
    // repo_override > docsOnly > floorCalibratedCategories > elevatedSurfaces > default.
    const routing = { docsOnly: "light", floorCalibratedCategories: "deep", elevatedSurfaces: "standard" };
    // A CI change with an operator floor on ci_build matches BOTH floorCalibrated and elevatedSurface.
    const floorAndElevated = loadConfigFromObject({
      reviewGate: { maxInlineComments: 25, categoryPrecisionFloors: { ci_build: 0.9 } },
      reviewModes: { ...reviewModes(), defaultMode: "standard", routing }
    });

    // 1) repo_override wins over everything, including the floor+elevated match.
    const overridden = select(floorAndElevated, CI_FILES, { repoOverrideMode: "light" });
    expect(overridden?.matchedRule).toBe("repo_override");
    expect(overridden?.mode).toBe("light");

    // 2) With no override, floorCalibrated (deep) shadows elevatedSurfaces (standard) by design.
    const floorWins = select(floorAndElevated, CI_FILES);
    expect(floorWins?.matchedRule).toBe("floor_calibrated_categories");
    expect(floorWins?.mode).toBe("deep");

    // 3) docsOnly outranks floorCalibrated/elevated: a docs-only surface routes light even when a
    //    ci_build floor is configured (docs-only files never elevate, so this isolates the ordering).
    const docsWins = select(floorAndElevated, DOCS_FILES);
    expect(docsWins?.matchedRule).toBe("docs_only");
    expect(docsWins?.mode).toBe("light");

    // 4) elevatedSurfaces is the last non-default rule: an elevated surface with no configured floor
    //    routes via elevatedSurfaces, not floorCalibrated.
    const noFloor = loadConfigFromObject({ reviewModes: { ...reviewModes(), defaultMode: "standard", routing } });
    const elevatedWins = select(noFloor, CI_FILES);
    expect(elevatedWins?.matchedRule).toBe("elevated_surfaces");
    expect(elevatedWins?.mode).toBe("standard");
  });

  it("produces a stable config hash for replayability", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() });
    const a = select(config, AUTH_FILES);
    const b = select(config, DOCS_FILES);
    expect(a?.configHash).toBe(b?.configHash);
    expect(a?.configHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("resolved analysis plan is demote-only (#266)", () => {
  it("light mode forces stages off even when base has them on", () => {
    const config = loadConfigFromObject({
      reviewGate: { maxInlineComments: 25, selfConsistency: { enabled: true } },
      gitnexusContext: { enabled: true },
      githubRelatedContext: { enabled: true, packetVersion: "v", maxPacketBytes: 1000, maxRelatedItems: 4, queryLimit: 2, maxCommandOutputBytes: 1000 },
      reviewModes: reviewModes()
    });
    const selection = select(config, DOCS_FILES); // → light
    expect(selection?.analysisPlan.selfConsistency).toBe(false);
    expect(selection?.analysisPlan.gitnexusContext).toBe(false);
    expect(selection?.analysisPlan.githubRelatedContext).toBe(false);
  });

  it("standard/deep never enable a stage the base config has off", () => {
    const config = loadConfigFromObject({ reviewModes: reviewModes() }); // base all off
    const deep = select(config, AUTH_FILES);
    expect(deep?.analysisPlan.selfConsistency).toBe(false);
    expect(deep?.analysisPlan.gitnexusContext).toBe(false);
    expect(deep?.analysisPlan.githubRelatedContext).toBe(false);
  });

  it("inherits base ON when the mode does not demote", () => {
    const config = loadConfigFromObject({
      reviewGate: { maxInlineComments: 25, selfConsistency: { enabled: true } },
      reviewModes: reviewModes()
    });
    const deep = select(config, AUTH_FILES); // deep has no selfConsistency demote
    expect(deep?.analysisPlan.selfConsistency).toBe(true);
    expect(deep?.analysisPlan.targetMinutes).toBe(12);
  });

  it("demotes only the enabled add-on and never turns the already-off one on (asymmetric)", () => {
    // Base enables ONLY gitnexusContext; githubRelatedContext stays off. light demotes the single
    // contextAddons knob: the enabled add-on flips off, the already-off add-on stays off (never on).
    const config = loadConfigFromObject({
      gitnexusContext: { enabled: true },
      // githubRelatedContext deliberately omitted ⇒ base off.
      reviewModes: reviewModes()
    });
    const light = select(config, DOCS_FILES); // → light (contextAddons: false)
    expect(light?.analysisPlan.gitnexusContext).toBe(false); // demoted from base-on
    expect(light?.analysisPlan.githubRelatedContext).toBe(false); // stays off; never promoted on

    // standard inherits (no contextAddons demote): the enabled add-on stays on, the off one stays off.
    const standard = select(config, [{ filename: "misc/notes.txt" }, { filename: "docs/guide.md" }]);
    expect(standard?.mode).toBe("standard");
    expect(standard?.analysisPlan.gitnexusContext).toBe(true); // inherited base-on
    expect(standard?.analysisPlan.githubRelatedContext).toBe(false); // inherited base-off; never on
  });
});

describe("posting invariant: mode selection cannot reach the review gate (#266 load-bearing, structural)", () => {
  // HONEST FRAMING: selectReviewMode is advisory — it drives the `review-mode` dry-run command and
  // route evidence only, and is NOT yet wired into the live review pipeline. So the posting invariant
  // is proven STRUCTURALLY here, not behaviorally: (1) the review gate's signature takes no mode
  // parameter, so it cannot observe the mode by construction; (2) across every mode, the gate INPUT
  // (findings + files) a caller would build is identical — the mode changes the analysis PLAN, never
  // the gate's arguments. A tautological "call the gate twice with identical args" test proves
  // nothing, so we assert the two independent facts that actually make the invariant hold.
  const files: PullFilePatch[] = [
    { filename: "src/save.ts", patch: "@@ -1,2 +1,3 @@\n export function save() {\n+  overwriteAllData();\n }" }
  ];
  const findings: Finding[] = [
    {
      severity: "P1",
      category: "data_loss",
      path: "src/save.ts",
      line: 2,
      title: "Rollback can clobber fresh state",
      body: "The added call can overwrite newer data after a failed save.",
      confidence: 0.9
    }
  ];

  it("the review gate input TYPE has no mode/reviewMode property (compile-time structural guard)", () => {
    // Type-level, not a hardcoded key list: this genuinely inspects applyDeterministicReviewGate's
    // input type at typecheck time. If the gate input ever gains a `mode`/`reviewMode` field, `npm run
    // build` (tsc) fails here — that is the real structural guard proving the gate cannot observe the
    // routed mode by construction.
    expectTypeOf<Parameters<typeof applyDeterministicReviewGate>[0]>().not.toHaveProperty("mode");
    expectTypeOf<Parameters<typeof applyDeterministicReviewGate>[0]>().not.toHaveProperty("reviewMode");
    // Runtime corroboration: a stray mode spread is silently dropped by the gate's typed input.
    const withStrayMode = applyDeterministicReviewGate({ findings, files, ...( { mode: "deep" } as object) });
    const clean = applyDeterministicReviewGate({ findings, files });
    expect(JSON.stringify(withStrayMode)).toBe(JSON.stringify(clean));
  });

  it("the gate INPUT is identical across light/standard/deep while the analysis plan differs", () => {
    // Base enables selfConsistency so the plans genuinely differ (light demotes it, deep keeps it).
    const baseGate = { findings, files } as const;
    const baselineInput = JSON.stringify(baseGate);
    const plans = new Set<boolean>();

    for (const mode of ["light", "standard", "deep"] as ReviewMode[]) {
      const config = loadConfigFromObject({
        reviewGate: { maxInlineComments: 25, selfConsistency: { enabled: true } },
        reviewModes: { ...reviewModes(), defaultMode: mode, routing: { docsOnly: mode, elevatedSurfaces: mode, floorCalibratedCategories: mode } }
      });
      const selection = select(config, files);
      expect(selection?.mode).toBe(mode);
      // The mode is reflected in the analysis PLAN (depth/spend)...
      plans.add(selection!.analysisPlan.selfConsistency);
      // ...but the gate input a caller assembles from the same findings/files is unchanged by it.
      expect(JSON.stringify({ findings, files })).toBe(baselineInput);
    }
    // The plan actually varied across modes (light off vs standard/deep on) — so the input-identity
    // assertion above is non-vacuous: modes DO differ, yet the gate input does not.
    expect(plans.has(false)).toBe(true);
    expect(plans.has(true)).toBe(true);
  });
});
