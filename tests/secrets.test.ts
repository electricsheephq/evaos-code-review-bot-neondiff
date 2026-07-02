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

  it("detects credential URLs, cookie headers, query tokens, and private key bodies", () => {
    const credentialUrl = "https://user:password1234567890@example.com/path";
    const cookieHeader = "Cookie: session=123456789012345678901234";
    const queryToken = "https://example.com/callback?token=123456789012345678901234";
    const privateKey = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";

    expect(containsSecretLikeText(credentialUrl)).toBe(true);
    expect(containsSecretLikeText(cookieHeader)).toBe(true);
    expect(containsSecretLikeText(queryToken)).toBe(true);
    expect(containsSecretLikeText(privateKey)).toBe(true);
    expect(redactSecrets(`${credentialUrl}\n${cookieHeader}\n${queryToken}\n${privateKey}`)).not.toMatch(
      /password1234567890|123456789012345678901234|BEGIN PRIVATE KEY/
    );
  });

  it("detects raw customer identifiers and SSN-shaped customer data", () => {
    const customerId = "customer_id=cus_12345678901234567890";
    const ssn = "customer_ssn=123-45-6789";
    const benignCustomerLabel = "customer_id = acme-corporation-12345";

    expect(containsSecretLikeText(customerId)).toBe(true);
    expect(containsSecretLikeText(ssn)).toBe(true);
    expect(containsSecretLikeText(benignCustomerLabel)).toBe(false);
    expect(redactSecrets(`${customerId}\n${ssn}`)).not.toMatch(/cus_12345678901234567890|123-45-6789/);
  });
});
