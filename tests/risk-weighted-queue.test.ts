import { describe, expect, it } from "vitest";
import { loadConfigFromObject, type BotConfig } from "../src/config.js";
import { riskWeightedQueuePriority } from "../src/scheduler.js";
import { buildChangedSurfaceValidationReport } from "../src/validation-selector.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";

function pull(): PullRequestSummary {
  return {
    number: 1,
    title: "PR",
    draft: false,
    head: { sha: "head", ref: "feature" },
    base: { sha: "base", ref: "main", repo: { full_name: "owner/repo" } },
    html_url: "https://example.invalid/owner/repo/pull/1"
  };
}

function report(files: PullFilePatch[]) {
  return buildChangedSurfaceValidationReport({ repo: "owner/repo", pull: pull(), files });
}

const AUTH_FILES: PullFilePatch[] = [{ filename: "src/auth/session.ts" }];
const DOCS_FILES: PullFilePatch[] = [{ filename: "docs/guide.md" }];

describe("risk-weighted queue priority (#301)", () => {
  it("keeps flat backgroundPriority for every tier when disabled (byte-identical)", () => {
    const config = loadConfigFromObject({ reviewScheduler: { backgroundPriority: 50 } });

    const auth = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(AUTH_FILES) });
    const docs = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(DOCS_FILES) });

    expect(auth.priority).toBe(50);
    expect(docs.priority).toBe(50);
    expect(auth.tier).toBe("default");
    expect(docs.tier).toBe("default");
  });

  it("elevates a required-validation surface above a docs-only surface when enabled", () => {
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: 70 }
    });

    const auth = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(AUTH_FILES) });
    const docs = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(DOCS_FILES) });

    // Lower number = leased sooner: the required-surface PR must outrank the docs-only PR.
    expect(auth.priority).toBe(20);
    expect(docs.priority).toBe(70);
    expect(auth.priority as number).toBeLessThan(docs.priority as number);
    expect(auth.tier).toBe("elevated");
    expect(docs.tier).toBe("docs_only");
    expect(auth.reason).toMatch(/risk/i);
  });

  it("falls back to backgroundPriority when enabled but no report is available", () => {
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: 70 }
    });

    const result = riskWeightedQueuePriority({ config, repo: "owner/repo" });

    expect(result.priority).toBe(50);
    expect(result.tier).toBe("default");
  });

  it("uses backgroundPriority defaults when elevated/docs priorities are unset but enabled", () => {
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true }
    });

    const auth = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(AUTH_FILES) });

    expect(auth.tier).toBe("elevated");
    expect(auth.priority).toBeLessThanOrEqual(50);
  });
});

describe("risk-weighted queue config (#301)", () => {
  it("defaults to disabled", () => {
    const config: BotConfig = loadConfigFromObject({});
    expect(config.riskWeightedQueue).toEqual({ enabled: false });
  });

  it("accepts explicit priorities", () => {
    const config = loadConfigFromObject({
      riskWeightedQueue: { enabled: true, elevatedPriority: 5, docsOnlyPriority: 80 }
    });
    expect(config.riskWeightedQueue).toEqual({ enabled: true, elevatedPriority: 5, docsOnlyPriority: 80 });
  });

  it("fails closed on a non-boolean enabled flag", () => {
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: "yes" } })).toThrow(
      /riskWeightedQueue\.enabled must be a boolean/
    );
  });

  it("fails closed on a negative or non-integer priority", () => {
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, elevatedPriority: -1 } })).toThrow(
      /riskWeightedQueue\.elevatedPriority must be a non-negative integer/
    );
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, docsOnlyPriority: 2.5 } })).toThrow(
      /riskWeightedQueue\.docsOnlyPriority must be a non-negative integer/
    );
  });

  it("fails closed when explicit priorities would lease docs-only before elevated work", () => {
    expect(() =>
      loadConfigFromObject({
        riskWeightedQueue: { enabled: true, elevatedPriority: 80, docsOnlyPriority: 20 }
      })
    ).toThrow(/riskWeightedQueue\.elevatedPriority must be <= .*docsOnlyPriority/);
  });

  it("validates explicit priorities against default priority fallbacks", () => {
    expect(() =>
      loadConfigFromObject({
        reviewScheduler: { backgroundPriority: 50 },
        riskWeightedQueue: { enabled: true, elevatedPriority: 80 }
      })
    ).toThrow(/riskWeightedQueue\.elevatedPriority must be <= .*docsOnlyPriority/);

    expect(() =>
      loadConfigFromObject({
        reviewScheduler: { backgroundPriority: 50 },
        riskWeightedQueue: { enabled: true, docsOnlyPriority: 5 }
      })
    ).toThrow(/riskWeightedQueue\.elevatedPriority must be <= .*docsOnlyPriority/);
  });
});
