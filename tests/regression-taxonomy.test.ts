import { describe, expect, it } from "vitest";
import { inferRegressionCategory, normalizeFindingCategory } from "../src/regression-taxonomy.js";
import type { Finding } from "../src/types.js";

describe("regression taxonomy", () => {
  it("keeps rollback notes in release-regression unless data/state loss is present", () => {
    expect(inferRegressionCategory(finding("docs/releases/v0.4.0.md", "Add rollback note", "Document the release rollback note."))).toBe(
      "release_regression"
    );
    expect(inferRegressionCategory(finding("src/save.ts", "Rollback clobbers save state", "Rollback can overwrite save data."))).toBe(
      "data_loss"
    );
  });

  it("keeps auth and security boundary categories distinct", () => {
    expect(inferRegressionCategory(finding("src/auth.ts", "Token refresh fails", "The session token is never refreshed."))).toBe("auth");
    expect(inferRegressionCategory(finding("src/config.ts", "Leaked private key", "The private key is copied into logs."))).toBe(
      "security_boundary"
    );
    expect(inferRegressionCategory(finding("src/auth.ts", "Leaked access token", "The handler writes an access token into audit logs."))).toBe(
      "security_boundary"
    );
  });
});

describe("normalizeFindingCategory precedence (#280)", () => {
  it("keeps a validated model category even when incidental keywords would infer another", () => {
    // Before #280 the inference chain ran first and 'token' reclassified this to auth.
    const result = normalizeFindingCategory(
      full({
        category: "runtime_correctness",
        path: "src/reviewer.ts",
        title: "Stale token cache",
        body: "The handler reuses a stale token and returns wrong output."
      })
    );

    expect(result).toBe("runtime_correctness");
  });

  it("does not de-escalate: keeps an RC-eligible model category over a docs-only inference", () => {
    // model data_loss (eligible) with docs-y path/text; inferred docs_only is INELIGIBLE, so the
    // escalate-only override does not fire and the model category is preserved.
    const result = normalizeFindingCategory(
      full({
        category: "data_loss",
        path: "docs/runbook.md",
        title: "Restore step overwrites live rows",
        body: "The documented restore step can overwrite live customer rows."
      })
    );

    expect(result).toBe("data_loss");
  });

  it("escalates across the eligibility boundary: RC-ineligible model, RC-eligible inference wins", () => {
    // model docs_only (ineligible) but the body infers security_boundary (eligible) — the safety
    // net escalates so a mislabeled security finding still blocks. Mirrors the main-test semantics.
    const result = normalizeFindingCategory(
      full({
        category: "docs_only",
        path: "docs/operator-cli.md",
        title: "Leaked private key in rollback docs",
        body: "The private key is pasted into the operator rollback instructions."
      })
    );

    expect(result).toBe("security_boundary");
  });

  it("treats a model category of unknown as absent and falls back to inference", () => {
    const result = normalizeFindingCategory(
      full({
        category: "unknown",
        path: "src/auth.ts",
        title: "Session token regression",
        body: "The session token refresh returns stale credentials."
      })
    );

    expect(result).toBe("auth");
  });

  it("falls back to inference when the model category is absent", () => {
    const result = normalizeFindingCategory(
      full({
        path: "src/auth.ts",
        title: "Session token regression",
        body: "The session token refresh returns stale credentials."
      })
    );

    expect(result).toBe("auth");
  });
});

function finding(path: string, title: string, body: string) {
  return { path, title, body };
}

function full(overrides: Partial<Finding> & Pick<Finding, "path" | "title" | "body">): Finding {
  return {
    severity: "P1",
    line: 1,
    confidence: 0.8,
    ...overrides
  };
}
