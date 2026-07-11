import { describe, expect, it } from "vitest";
import { requestGitHubActionsOidcToken } from "../scripts/lib/github-actions-oidc-token.mjs";

describe("GitHub Actions OIDC token request", () => {
  it("uses the fixed lifecycle audience and keeps the runner request token in authorization only", async () => {
    const requestToken = "runner-request-token-fixture";
    let observedUrl = "";
    const token = await requestGitHubActionsOidcToken({
      requestUrl: "https://vstoken.actions.githubusercontent.com/example?api-version=2.0",
      requestToken,
      audience: "neondiff-license-lifecycle",
      fetchImpl: async (url: URL, init: RequestInit) => {
        observedUrl = String(url);
        expect(init.headers).toEqual({ authorization: `Bearer ${requestToken}` });
        return new Response(JSON.stringify({ value: "header.claims.signature" }), { status: 200 });
      }
    });
    expect(token).toBe("header.claims.signature");
    expect(new URL(observedUrl).searchParams.get("audience")).toBe("neondiff-license-lifecycle");
    expect(observedUrl).not.toContain(requestToken);
  });

  it("rejects untrusted request hosts and malformed token responses", async () => {
    await expect(requestGitHubActionsOidcToken({
      requestUrl: "https://example.com/token",
      requestToken: "runner-request-token-fixture",
      audience: "neondiff-license-lifecycle",
      fetchImpl: fetch
    })).rejects.toThrow("not trusted");
    await expect(requestGitHubActionsOidcToken({
      requestUrl: "https://vstoken.actions.githubusercontent.com/example",
      requestToken: "runner-request-token-fixture",
      audience: "neondiff-license-lifecycle",
      fetchImpl: async () => new Response(JSON.stringify({ value: "not-a-jwt" }), { status: 200 })
    })).rejects.toThrow("response is invalid");
  });
});
