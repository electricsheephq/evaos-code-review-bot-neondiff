import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";

describe("GitHub App read authentication", () => {
  const roots: string[] = [];
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses installation tokens for PR read calls when App credentials are configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-app-read-"));
    roots.push(root);
    const privateKeyPath = join(root, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }));

    const calls: Array<{ url: string; authorization?: string }> = [];
    globalThis.fetch = vi.fn(async (url, init) => {
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({ url: String(url), authorization });
      if (String(url).endsWith("/repos/owner/repo/installation")) {
        return jsonResponse({ id: 123 });
      }
      if (String(url).endsWith("/app/installations/123/access_tokens")) {
        return jsonResponse({ token: "installation-token", expires_at: "2999-01-01T00:00:00Z" });
      }
      if (String(url).endsWith("/repos/owner/repo/pulls?state=open&per_page=100")) {
        return jsonResponse([]);
      }
      return jsonResponse({ message: "unexpected" }, 404);
    }) as typeof fetch;

    const github = new GitHubApi({ appId: "4184532", privateKeyPath, token: "fallback-token" });
    await github.listOpenPulls("owner/repo");

    const readCall = calls.find((call) => call.url.endsWith("/repos/owner/repo/pulls?state=open&per_page=100"));
    expect(readCall?.authorization).toBe("Bearer installation-token");
    expect(readCall?.authorization).not.toBe("Bearer fallback-token");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
