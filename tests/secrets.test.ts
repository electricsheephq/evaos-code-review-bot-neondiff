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
    const shortCredentialUrl = "https://deploy:Pa55@host";
    const encodedUserinfoUrl = "https://deploy%40example.com:Pa55@host";
    const awsAccessKey = "AKIA1234567890ABCDEF";
    const slackToken = "xoxb-123456789012-abcdefSECRET";
    const cookieHeader = "Cookie: session=123456789012345678901234";
    const queryToken = "https://example.com/callback?token=123456789012345678901234";
    const privateKey = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    const truncatedPrivateKey = "-----BEGIN PRIVATE KEY-----\nsensitive-key-material-without-footer";

    expect(containsSecretLikeText(credentialUrl)).toBe(true);
    expect(containsSecretLikeText(shortCredentialUrl)).toBe(true);
    expect(containsSecretLikeText(encodedUserinfoUrl)).toBe(true);
    expect(containsSecretLikeText(awsAccessKey)).toBe(true);
    expect(containsSecretLikeText(slackToken)).toBe(true);
    expect(containsSecretLikeText(cookieHeader)).toBe(true);
    expect(containsSecretLikeText(queryToken)).toBe(true);
    expect(containsSecretLikeText(privateKey)).toBe(true);
    expect(containsSecretLikeText(truncatedPrivateKey)).toBe(true);
    expect(redactSecrets([
      credentialUrl,
      shortCredentialUrl,
      encodedUserinfoUrl,
      awsAccessKey,
      slackToken,
      cookieHeader,
      queryToken,
      privateKey,
      truncatedPrivateKey
    ].join("\n"))).not.toMatch(
      /password1234567890|Pa55|AKIA1234567890ABCDEF|xoxb-|123456789012345678901234|BEGIN PRIVATE KEY|sensitive-key-material/
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
