import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { canonicalSecretRules } from "../src/generated-secret-rules.js";
import { containsSecretLikeText } from "../src/secrets.js";
import { canonicalSecretRuleCorpus } from "./generated-secret-rule-corpus.js";

describe("canonical secret rule parity", () => {
  it("keeps every canonical sensitive and benign corpus case bound to Node production behavior", () => {
    expect(canonicalSecretRuleCorpus.sensitive.length).toBe(canonicalSecretRuleCorpus.ruleIds.length);
    const rulesById = new Map(canonicalSecretRules.map((rule) => [rule.id, rule]));
    for (const fixture of canonicalSecretRuleCorpus.sensitive) {
      expect(containsSecretLikeText(fixture.text), fixture.id).toBe(true);
      if (fixture.id !== "sensitive-cookie-header") {
        const rule = rulesById.get(fixture.id);
        expect(rule, fixture.id).toBeDefined();
        expect(new RegExp(rule!.source, rule!.ignoreCase ? "i" : "").test(fixture.text), fixture.id).toBe(true);
      }
    }
    for (const fixture of canonicalSecretRuleCorpus.benign) {
      expect(containsSecretLikeText(fixture.text), fixture.id).toBe(false);
    }
  });

  it("keeps generated Node and Swift matchers synchronized with the shared canonical source", () => {
    const result = spawnSync(process.execPath, ["scripts/generate-secret-rules.mjs", "--check"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
