import { describe, expect, it } from "vitest";
import { parseFindings } from "../src/findings.js";
import { validateFindingLocations } from "../src/diff.js";
import { findScenario, QA_LAB_SCENARIOS } from "../scripts/qa-lab/scenarios.js";
import {
  findConfigVariant,
  HERMETIC_EXECUTABLE_VARIANTS,
  QA_LAB_CONFIG_VARIANT_IDS,
  QA_LAB_CONFIG_VARIANTS
} from "../scripts/qa-lab/config-variants.js";

describe("QA_LAB_SCENARIOS", () => {
  it("covers exactly the six scenario classes required by issue #341", () => {
    const classes = QA_LAB_SCENARIOS.map((scenario) => scenario.scenarioClass).sort();
    expect(classes).toEqual(
      ["auth_security", "docs_only", "issue_burst", "migration", "normal_code", "release_config"].sort()
    );
  });

  it("has a unique id for every scenario", () => {
    const ids = QA_LAB_SCENARIOS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds a scenario by id and returns undefined for an unknown id", () => {
    expect(findScenario("docs-only-readme-typo")?.scenarioClass).toBe("docs_only");
    expect(findScenario("does-not-exist")).toBeUndefined();
  });

  it("every scenario's raw botFindings parses cleanly through the real parseFindings schema gate", () => {
    for (const scenario of QA_LAB_SCENARIOS) {
      const parsed = parseFindings(scenario.botFindings);
      expect(parsed.dropped, `scenario ${scenario.id} had schema-invalid seeded findings`).toEqual([]);
      expect(parsed.findings.length).toBeGreaterThan(0);
    }
  });

  it("every scenario's seeded finding locations are valid against its own diff context", () => {
    for (const scenario of QA_LAB_SCENARIOS) {
      const parsed = parseFindings(scenario.botFindings);
      const located = validateFindingLocations(parsed.findings, scenario.files);
      expect(located.dropped, `scenario ${scenario.id} had a finding location not present in its own diff`).toEqual([]);
    }
  });
});

describe("QA lab config variants", () => {
  it("declares one variant per configured variant id", () => {
    const variantIds = QA_LAB_CONFIG_VARIANTS.map((variant) => variant.id).sort();
    expect(variantIds).toEqual([...QA_LAB_CONFIG_VARIANT_IDS].sort());
  });

  it("only the baseline variant is hermetic-executable in pass 1", () => {
    expect(HERMETIC_EXECUTABLE_VARIANTS).toEqual(["baseline"]);
  });

  it("marks every non-baseline variant as requiring a live provider or GitHub call, except repo_memory", () => {
    for (const variant of QA_LAB_CONFIG_VARIANTS) {
      if (variant.id === "baseline" || variant.id === "repo_memory") continue;
      expect(variant.requiresLiveProviderOrGithub, `variant ${variant.id} should require live provider/GitHub calls`).toBe(true);
    }
  });

  it("finds a variant by id and returns undefined for an unknown id", () => {
    expect(findConfigVariant("baseline")?.id).toBe("baseline");
    expect(findConfigVariant("not-a-real-variant")).toBeUndefined();
  });
});
