import { describe, expect, it } from "vitest";
import { inferRegressionCategory } from "../src/regression-taxonomy.js";

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
  });
});

function finding(path: string, title: string, body: string) {
  return { path, title, body };
}
