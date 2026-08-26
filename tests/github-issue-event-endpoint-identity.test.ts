import { describe, expect, it } from "vitest";
import { matchesGitHubIssueEventEndpointIdentity, resolveGitHubIssueEventEndpointIdentity } from "../src/github-issue-event-endpoint-identity.js";

const valid = {
  apiBaseUrl: "https://api.github.com",
  repository: "electric-sheep/neondiff.js",
  repositoryId: 1_285_247_004,
  issueNumber: 990
};

describe("exact raw GitHub issue-event endpoint identity", () => {
  it("derives immutable GitHub.com and Enterprise identities", () => {
    expect(resolveGitHubIssueEventEndpointIdentity(valid)).toEqual({
      ok: true,
      identity: {
        origin: "https://api.github.com",
        basePath: "",
        repositoryPath: "/repos/electric-sheep/neondiff.js/issues/990/events",
        canonicalRepositoryPath: "/repositories/1285247004/issues/990/events"
      }
    });
    const enterprise = resolveGitHubIssueEventEndpointIdentity({ ...valid, apiBaseUrl: "https://ghe.example.com/api/v3/" });
    expect(enterprise).toEqual({
      ok: true,
      identity: {
        origin: "https://ghe.example.com",
        basePath: "/api/v3",
        repositoryPath: "/api/v3/repos/electric-sheep/neondiff.js/issues/990/events",
        canonicalRepositoryPath: "/api/v3/repositories/1285247004/issues/990/events"
      }
    });
    expect(enterprise.ok && Object.isFrozen(enterprise.identity)).toBe(true);
    expect(Object.isFrozen(enterprise)).toBe(true);
  });

  it("matches only exact raw target serializations", () => {
    const result = resolveGitHubIssueEventEndpointIdentity({ ...valid, apiBaseUrl: "https://ghe.example.com/api/v3" });
    if (!result.ok) throw new Error("expected valid identity");
    const accepted = [
      "https://ghe.example.com/api/v3/repos/electric-sheep/neondiff.js/issues/990/events",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/events"
    ];
    for (const target of accepted) expect(matchesGitHubIssueEventEndpointIdentity(result.identity, target)).toBe(true);
    const rejected = [
      "https://other.example.com/api/v3/repositories/1285247004/issues/990/events",
      "https://ghe.example.com/repositories/1285247004/issues/990/events",
      "https://ghe.example.com/api/v3/repositories/9/issues/990/events",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/991/events",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/events/extra",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/events?",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/events#",
      "https://@ghe.example.com/api/v3/repositories/1285247004/issues/990/events",
      "https://ghe.example.com\\api\\v3\\repositories\\1285247004\\issues\\990\\events",
      "https://ghe.example.com/api/v3/repositories/%31%32%38%35%32%34%37%30%30%34/issues/990/events",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/x/../events",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/{events}",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/e^ents",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/e`ents",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/e\"ents",
      "https://ghe.example.com/api/v3/repositories/1285247004/issues/990/évents"
    ];
    for (const target of rejected) expect(matchesGitHubIssueEventEndpointIdentity(result.identity, target)).toBe(false);

    const forgedArray = Object.freeze(Object.assign([], result.identity));
    expect(matchesGitHubIssueEventEndpointIdentity(
      forgedArray as unknown as typeof result.identity,
      accepted[0]
    )).toBe(false);
    const nullPrototype = Object.freeze(Object.assign(Object.create(null), result.identity));
    expect(matchesGitHubIssueEventEndpointIdentity(
      nullPrototype as typeof result.identity,
      accepted[0]
    )).toBe(false);
  });

  it("rejects noncanonical base and malformed identity input", () => {
    const rejected = [
      { apiBaseUrl: "http://ghe.example.com/api/v3" },
      { apiBaseUrl: "https://@ghe.example.com/api/v3" },
      { apiBaseUrl: "https://ghe.example.com/api/v3?" },
      { apiBaseUrl: "https://ghe.example.com/api/v3#" },
      { apiBaseUrl: "https://ghe.example.com/api/%76%33" },
      { apiBaseUrl: "https://ghe.example.com/api/../v3" },
      { apiBaseUrl: "https://ghe.example.com/api/{v3}" },
      { apiBaseUrl: "https://ghe.example.com/api/v^3" },
      { apiBaseUrl: "https://ghe.example.com/api/v`3" },
      { apiBaseUrl: "https://ghe.example.com/api/v\"3" },
      { apiBaseUrl: "https://ghe.example.com/api/é" },
      { repository: "electric-sheep" },
      { repository: 42 },
      { repositoryId: 0 },
      { repositoryId: Number.MAX_SAFE_INTEGER + 1 },
      { issueNumber: 0 }
    ];
    for (const change of rejected) {
      const result = resolveGitHubIssueEventEndpointIdentity({ ...valid, ...change });
      expect(result).toEqual({ ok: false, reason: "invalid_endpoint_identity" });
      expect(Object.isFrozen(result)).toBe(true);
    }
    expect(resolveGitHubIssueEventEndpointIdentity({ ...valid, apiBaseUrl: "http://127.0.0.1:3000/api/v3" }).ok).toBe(true);
  });
});
