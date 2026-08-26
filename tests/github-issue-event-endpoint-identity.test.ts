import { describe, expect, it } from "vitest";
import { matchesGitHubIssueEventEndpointIdentity, resolveGitHubIssueEventEndpointIdentity } from "../src/github-issue-event-endpoint-identity.js";

const valid = {
  apiBaseUrl: "https://api.github.com",
  repository: "electric-sheep/neondiff.js",
  repositoryId: 1_285_247_004,
  issueNumber: 990
};

describe("GitHub issue-event endpoint identity", () => {
  it("derives exact GitHub.com owner and numeric repository paths", () => {
    const result = resolveGitHubIssueEventEndpointIdentity(valid);
    expect(result).toEqual({
      ok: true,
      identity: {
        origin: "https://api.github.com",
        basePath: "",
        repositoryPath: "/repos/electric-sheep/neondiff.js/issues/990/events",
        canonicalRepositoryPath: "/repositories/1285247004/issues/990/events"
      }
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.ok && Object.isFrozen(result.identity)).toBe(true);
  });

  it("preserves a GitHub Enterprise API base prefix", () => {
    expect(resolveGitHubIssueEventEndpointIdentity({ ...valid, apiBaseUrl: "https://ghe.example.com/api/v3/" })).toEqual({
      ok: true,
      identity: {
        origin: "https://ghe.example.com",
        basePath: "/api/v3",
        repositoryPath: "/api/v3/repos/electric-sheep/neondiff.js/issues/990/events",
        canonicalRepositoryPath: "/api/v3/repositories/1285247004/issues/990/events"
      }
    });
    expect(resolveGitHubIssueEventEndpointIdentity({ ...valid, apiBaseUrl: "http://127.0.0.1:3000/api/v3" }).ok).toBe(true);
  });

  it("matches only the exact configured origin and either derived path", () => {
    const result = resolveGitHubIssueEventEndpointIdentity({ ...valid, apiBaseUrl: "https://ghe.example.com/api/v3" });
    if (!result.ok) throw new Error("expected valid identity");
    expect(matchesGitHubIssueEventEndpointIdentity(result.identity, "https://ghe.example.com/api/v3/repos/electric-sheep/neondiff.js/issues/990/events")).toBe(true);
    expect(matchesGitHubIssueEventEndpointIdentity(result.identity, "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/events")).toBe(true);
    for (const target of [
      `https://other.example.com${result.identity.canonicalRepositoryPath}`,
      "https://ghe.example.com/repositories/1285247004/issues/990/events",
      "https://ghe.example.com/api/v3/repositories/9/issues/990/events",
      "https://ghe.example.com/api/v3/repos/other/neondiff.js/issues/990/events",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/991/events",
      `https://ghe.example.com${result.identity.canonicalRepositoryPath}/extra`,
      `https://ghe.example.com${result.identity.canonicalRepositoryPath}?page=2`,
      `https://ghe.example.com${result.identity.canonicalRepositoryPath}?`,
      `https://ghe.example.com${result.identity.canonicalRepositoryPath}#fragment`,
      `https://ghe.example.com${result.identity.canonicalRepositoryPath}#`,
      `https://token@ghe.example.com${result.identity.canonicalRepositoryPath}`,
      `https://@ghe.example.com${result.identity.canonicalRepositoryPath}`,
      "https://ghe.example.com\\api\\v3\\repositories\\1285247004\\issues\\990\\events",
      "https://ghe.example.com/api/v3/repositories/%31%32%38%35%32%34%37%30%30%34/issues/990/events",
      "https://ghe.example.com/api/v3/repos/electric-sheep/neondiff.é/issues/990/events"
    ]) expect(matchesGitHubIssueEventEndpointIdentity(result.identity, target)).toBe(false);
  });

  it("rejects malformed or ambiguous identity inputs", () => {
    const invalid = [
      { apiBaseUrl: "http://ghe.example.com/api/v3" },
      { apiBaseUrl: "https://token@ghe.example.com/api/v3" },
      { apiBaseUrl: "https://ghe.example.com/api/v3?tenant=x" },
      { apiBaseUrl: "https://ghe.example.com/api/v3?" },
      { apiBaseUrl: "https://ghe.example.com/api/v3#fragment" },
      { apiBaseUrl: "https://ghe.example.com/api/v3#" },
      { apiBaseUrl: "https://@ghe.example.com/api/v3" },
      { apiBaseUrl: "https://ghe.example.com/api/%76%33" },
      { apiBaseUrl: "https://ghe.example.com/api/é" },
      { apiBaseUrl: "https://ghe.example.com/api/../v3" },
      { apiBaseUrl: "https://ghe.example.com/api/.." },
      { repository: "electric-sheep" },
      { repository: "electric-sheep/../repo" },
      { repository: "electric_sheep/repo" },
      { repository: 42 },
      { repositoryId: 0 },
      { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
      { issueNumber: 0 },
      { issueNumber: Number.MAX_SAFE_INTEGER + 1 }
    ];
    for (const change of invalid) {
      const result = resolveGitHubIssueEventEndpointIdentity({ ...valid, ...change });
      expect(result).toEqual({ ok: false, reason: "invalid_endpoint_identity" });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });
});
