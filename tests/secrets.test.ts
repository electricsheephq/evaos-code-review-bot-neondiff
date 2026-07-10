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

  it("redacts NeonDiff license-shaped values case-insensitively", () => {
    const license = "neondiff_abcd1234efgh5678";

    expect(containsSecretLikeText(license)).toBe(true);
    expect(redactSecrets(`license=${license}`)).toBe("license=[redacted-secret]");
  });

  it("redacts lowercase live license keys from checkout issuance responses", () => {
    const license = "nd_live_abcdefgh12345678";

    expect(containsSecretLikeText(license)).toBe(true);
    expect(redactSecrets(`licenseKey=${license}`)).toBe("licenseKey=[redacted-secret]");
  });

  it("does not redact documented NeonDiff environment variable names", () => {
    const text = "Set NEONDIFF_GITHUB_APP_ID and NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH before doctor github.";

    expect(containsSecretLikeText(text)).toBe(false);
    expect(redactSecrets(text)).toBe(text);
  });

  it("only protects safe environment names when they are standalone references", () => {
    const benignReferences = [
      "Set NEONDIFF_PROVIDER_API_KEY before running verification.",
      "Required: `NEONDIFF_PROVIDER_API_KEY`.",
      "Read NEONDIFF_PROVIDER_API_KEY, then continue."
    ];
    const sensitiveAssignments = [
      "NEONDIFF_PROVIDER_API_KEY=abcdefghijklmnop",
      "NEONDIFF_PROVIDER_API_KEY = abcdefghijklmnop",
      "\"NEONDIFF_PROVIDER_API_KEY\": \"abcdefghijklmnop\"",
      "'NEONDIFF_PROVIDER_API_KEY' : 'abcdefghijklmnop'",
      "token=NEONDIFF_PROVIDER_API_KEY"
    ];

    for (const text of benignReferences) {
      expect(containsSecretLikeText(text), text).toBe(false);
      expect(redactSecrets(text), text).toBe(text);
    }
    for (const text of sensitiveAssignments) {
      expect(containsSecretLikeText(text), text).toBe(true);
      expect(redactSecrets(text), text).toContain("[redacted-secret]");
    }
  });

  it("redacts hyphenated license-shaped values case-insensitively", () => {
    const license = "neondiff-revocation-reason-test-123456";
    const digitPoorLicense = "NDL-XQKM-RPYB-SUTE";

    expect(containsSecretLikeText(license)).toBe(true);
    expect(redactSecrets(`license=${license}`)).toBe("license=[redacted-secret]");
    expect(containsSecretLikeText(digitPoorLicense)).toBe(true);
    expect(redactSecrets(`license=${digitPoorLicense}`)).toBe("license=[redacted-secret]");
  });

  it("does not redact ordinary lowercase hyphenated NeonDiff paths or labels as license tokens", () => {
    const path = "/tmp/neondiff-launchd-plist-Ov4D5v/com.example.neondiff.plist";
    const label = "lic-diagnostic-reference-without-key-material";

    expect(containsSecretLikeText(path)).toBe(false);
    expect(redactSecrets(path)).toBe(path);
    expect(containsSecretLikeText(label)).toBe(false);
    expect(redactSecrets(label)).toBe(label);
  });

  it("detects credential URLs, cookie headers, query tokens, and private key bodies", () => {
    const longSecret = ["123456789012", "345678901234"].join("");
    const password = ["password", "1234567890"].join("");
    const shortPassword = ["Pa", "55"].join("");
    const credentialUrl = `https://user:${password}@example.com/path`;
    const shortCredentialUrl = `https://deploy:${shortPassword}@host`;
    const encodedUserinfoUrl = `https://deploy%40example.com:${shortPassword}@host`;
    const awsAccessKey = ["AKIA", "1234567890ABCDEF"].join("");
    const temporaryAwsAccessKey = ["ASIA", "1234567890ABCDEF"].join("");
    const slackToken = ["xoxb", "123456789012", "abcdefSECRET"].join("-");
    const cookieHeader = `Cookie: session=${longSecret}`;
    const laterSensitiveCookieHeader = `Cookie: theme=light; session=${longSecret}`;
    const queryToken = `https://example.com/callback?token=${longSecret}`;
    const privateKeyHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
    const privateKeyFooter = ["-----END", "PRIVATE KEY-----"].join(" ");
    const privateKey = [privateKeyHeader, "abc", privateKeyFooter].join("\n");
    const truncatedPrivateKey = [privateKeyHeader, "sensitive-key-material-without-footer"].join("\n");

    expect(containsSecretLikeText(credentialUrl)).toBe(true);
    expect(containsSecretLikeText(shortCredentialUrl)).toBe(true);
    expect(containsSecretLikeText(encodedUserinfoUrl)).toBe(true);
    expect(containsSecretLikeText(awsAccessKey)).toBe(true);
    expect(containsSecretLikeText(temporaryAwsAccessKey)).toBe(true);
    expect(containsSecretLikeText(slackToken)).toBe(true);
    expect(containsSecretLikeText(cookieHeader)).toBe(true);
    expect(containsSecretLikeText(laterSensitiveCookieHeader)).toBe(true);
    expect(containsSecretLikeText(queryToken)).toBe(true);
    expect(containsSecretLikeText(privateKey)).toBe(true);
    expect(containsSecretLikeText(truncatedPrivateKey)).toBe(true);
    const redacted = redactSecrets([
      credentialUrl,
      shortCredentialUrl,
      encodedUserinfoUrl,
      awsAccessKey,
      temporaryAwsAccessKey,
      slackToken,
      cookieHeader,
      laterSensitiveCookieHeader,
      queryToken,
      privateKey,
      truncatedPrivateKey
    ].join("\n"));
    for (const forbidden of [
      password,
      shortPassword,
      awsAccessKey,
      temporaryAwsAccessKey,
      "xoxb-",
      longSecret,
      privateKeyHeader,
      "sensitive-key-material"
    ]) {
      expect(redacted).not.toContain(forbidden);
    }
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

  it("keeps already-stringified JSON parseable after redaction", () => {
    const output = redactSecrets(JSON.stringify({
      ok: true,
      token: "abcdefghijklmnop",
      message: "status payload"
    }, null, 2));

    const parsed = JSON.parse(output);

    expect(parsed.ok).toBe(true);
    expect(parsed.message).toBe("status payload");
    expect(typeof parsed.token).toBe("string");

    const safeNameKey = JSON.parse(redactSecrets(JSON.stringify({
      NEONDIFF_PROVIDER_API_KEY: "abcdefghijklmnop"
    })));
    expect(safeNameKey.NEONDIFF_PROVIDER_API_KEY).toBe("[redacted-secret]");
  });

  it("redacts sensitive long cookie headers without scanning unbounded attribute chains", () => {
    const longCookiePrefix = Array.from({ length: 600 }, (_, index) => `pref${index}=value`).join("; ");
    const sessionToken = "123456789012345678901234";
    const text = `Cookie: ${longCookiePrefix}; session=${sessionToken}`;

    expect(containsSecretLikeText(text)).toBe(true);
    expect(redactSecrets(text)).toBe("[redacted-secret]");
  });

  it("fails closed on short sensitive cookie values", () => {
    const text = "Cookie: theme=light; session=short";

    expect(containsSecretLikeText(text)).toBe(true);
    expect(redactSecrets(text)).toBe("[redacted-secret]");
  });

  it("fails closed when a cookie header exceeds the bounded scan cap", () => {
    const longCookiePrefix = Array.from({ length: 1_000 }, (_, index) => `pref${index}=value`).join("; ");
    const hiddenSessionToken = "123456789012345678901234";
    const text = `Cookie: ${longCookiePrefix}; session=${hiddenSessionToken}`;

    expect(containsSecretLikeText(text)).toBe(true);
    expect(redactSecrets(text)).toBe("[redacted-secret]");
  });
});
