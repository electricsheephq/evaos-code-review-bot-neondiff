import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { canonicalSecretRules, canonicalSensitiveCookieRule } from "../src/generated-secret-rules.js";
import { containsSecretLikeText } from "../src/secrets.js";
import { canonicalSecretRuleCorpus } from "./generated-secret-rule-corpus.js";

const execFileAsync = promisify(execFile);

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

  it("projects only runtime cookie fields into production Node output", () => {
    expect(Object.keys(canonicalSensitiveCookieRule).sort()).toEqual([
      "id",
      "maximumAttributes",
      "prefix",
      "sensitiveNameSource"
    ]);
  });

  it("keeps every canonical sensitive fixture out of production source, build, and npm payload", () => {
    const result = spawnSync(process.execPath, ["scripts/check-secret-rule-release.mjs", "--build", "--pack"], {
      cwd: process.cwd(),
      encoding: "utf8"
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 30_000);

  it("uses regex syntax with matching ECMAScript and Foundation semantics", () => {
    for (const rule of canonicalSecretRules) {
      expect(rule.source, rule.id).not.toMatch(/\\[bds]/);
      expect(rule.ignoreCase, rule.id).toBe(false);
    }
    expect(canonicalSensitiveCookieRule.sensitiveNameSource).not.toMatch(/\\[bds]/);
  });

  it("differentially matches every rule in Node and Foundation across boundary variants", async () => {
    const result = await execFileAsync(process.execPath, ["scripts/check-secret-rule-differential.mjs", "--require-swift"], {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    expect(`${result.stdout}\n${result.stderr}`).toContain("secret rule differential ok");
  }, 90_000);

  it("drives both production scanners with independently expected differential cases", () => {
    const differential = readFileSync("scripts/check-secret-rule-differential.mjs", "utf8");
    const swiftRunner = readFileSync("scripts/secret-rule-foundation-runner.swift", "utf8");

    expect(differential).toContain("dist/src/secrets.js");
    expect(differential).toContain("CanonicalSecretScanner.swift");
    expect(differential).toContain("expected");
    expect(differential).not.toContain("function nodeMatches");
    expect(differential).not.toContain("function matchesCookie");
    expect(swiftRunner).toContain("CanonicalSecretScanner.containsSecretLikeText");
    expect(swiftRunner).not.toContain("NSRegularExpression");
  });
});
