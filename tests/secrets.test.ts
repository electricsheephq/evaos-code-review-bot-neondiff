import { describe, expect, it } from "vitest";
import { containsSecretLikeText, redactSecrets } from "../src/secrets.js";

describe("secret redaction", () => {
  it("detects and redacts hyphenated fixture tokens", () => {
    const fixtureToken = ["super", "secret", "token"].join("-");
    const text = `fixture contains ${fixtureToken} in source`;

    expect(containsSecretLikeText(text)).toBe(true);
    expect(redactSecrets(text)).toBe("fixture contains [redacted-secret] in source");
  });

  it("redacts raw email addresses from evidence and comments", () => {
    const text = "Use person@example.com only via env.";

    expect(containsSecretLikeText(text)).toBe(true);
    expect(redactSecrets(text)).toBe("Use [redacted-secret] only via env.");
  });
});
