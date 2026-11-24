import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCiConfig, readCiPullContext } from "../src/ci-mode.js";
import { collectReviewEventAuthorizationAttempts, collectTrustedReviewCommands } from "../src/commands.js";
import { loadConfigFromObject } from "../src/config.js";
import { listCommandEnabledRepos, resolveRepoCommandConfig } from "../src/repo-policy.js";

const HEAD = "a".repeat(40);
const globalCommands = {
  enabled: false,
  botMentions: ["@neondiff"],
  trustedAuthors: ["global-maintainer"],
  acknowledge: true
};

function configWith(repoCommands?: unknown, commands: Record<string, unknown> = globalCommands) {
  return loadConfigFromObject({
    commands,
    repoProfiles: {
      repos: {
        "org/repo-x": repoCommands === undefined ? {} : { commands: repoCommands },
        "org/repo-y": {}
      }
    }
  });
}

function comment(id: number, login: string, body: string) {
  return { id, body, html_url: `https://github.test/comment/${id}`, user: { login, type: "User" } };
}

describe("per-repo command config resolution", () => {
  it("enables one repo while the global flag stays off, and leaves other repos off", () => {
    const config = configWith({ enabled: true, trustedAuthors: ["repo-maintainer"] });
    expect(resolveRepoCommandConfig(config, "org/repo-x")).toMatchObject({
      enabled: true,
      trustedAuthors: ["repo-maintainer"],
      botMentions: ["@neondiff"],
      acknowledge: true
    });
    expect(resolveRepoCommandConfig(config, "ORG/Repo-X").enabled).toBe(true);
    expect(resolveRepoCommandConfig(config, "org/repo-y")).toBe(config.commands);
    expect(resolveRepoCommandConfig(config, "org/unlisted")).toBe(config.commands);
    expect(listCommandEnabledRepos(config, ["org/repo-x", "org/repo-y"])).toEqual(["org/repo-x"]);
    expect(config.commands.enabled).toBe(false);
  });

  it("falls back to the global trusted authors when the repo sets only enabled", () => {
    const config = configWith({ enabled: true });
    expect(resolveRepoCommandConfig(config, "org/repo-x")).toMatchObject({ enabled: true, trustedAuthors: ["global-maintainer"] });
  });

  it("replaces (never merges) the global trusted authors for that repo only", () => {
    const config = configWith({ trustedAuthors: ["repo-maintainer"] }, { ...globalCommands, enabled: true });
    const repoX = resolveRepoCommandConfig(config, "org/repo-x");
    const repoY = resolveRepoCommandConfig(config, "org/repo-y");
    expect(repoX).toMatchObject({ enabled: true, trustedAuthors: ["repo-maintainer"] });
    expect(repoY.trustedAuthors).toEqual(["global-maintainer"]);

    const comments = [
      comment(1, "global-maintainer", "@neondiff review"),
      comment(2, "repo-maintainer", "@neondiff review")
    ];
    expect(collectTrustedReviewCommands(comments, repoX).commands.map((command) => command.author)).toEqual(["repo-maintainer"]);
    expect(collectTrustedReviewCommands(comments, repoY).commands.map((command) => command.author)).toEqual(["global-maintainer"]);
  });

  it("lets a repo turn commands off while the global flag is on", () => {
    const config = configWith({ enabled: false }, { ...globalCommands, enabled: true });
    expect(resolveRepoCommandConfig(config, "org/repo-x").enabled).toBe(false);
    expect(resolveRepoCommandConfig(config, "org/repo-y").enabled).toBe(true);
  });

  it("is byte-identical to the global block when no repo sets commands", () => {
    const config = configWith(undefined, { ...globalCommands, enabled: true });
    for (const repo of ["org/repo-x", "org/repo-y", "org/unlisted"]) {
      expect(resolveRepoCommandConfig(config, repo)).toBe(config.commands);
    }
    const noRegistry = loadConfigFromObject({ commands: globalCommands });
    expect(resolveRepoCommandConfig(noRegistry, "org/repo-x")).toBe(noRegistry.commands);
  });

  it("scopes the one-shot request-changes authorization to the enabled repo's trusted authors", () => {
    const config = configWith({ enabled: true, trustedAuthors: ["repo-maintainer"] });
    const body = (repo: string) => `@neondiff request-changes --repo ${repo} --pr 1 --head ${HEAD}`;
    const onX = collectReviewEventAuthorizationAttempts(
      [comment(10, "repo-maintainer", body("org/repo-x")), comment(11, "drive-by", body("org/repo-x"))],
      resolveRepoCommandConfig(config, "org/repo-x"),
      { repo: "org/repo-x", pullNumber: 1, headSha: HEAD }
    );
    expect(onX.reviewRequests.map((request) => request.author)).toEqual(["repo-maintainer"]);
    expect(onX.attempts.map((attempt) => attempt.status)).toEqual(["eligible", "untrusted"]);

    const onY = collectReviewEventAuthorizationAttempts(
      [comment(12, "repo-maintainer", body("org/repo-y"))],
      resolveRepoCommandConfig(config, "org/repo-y"),
      { repo: "org/repo-y", pullNumber: 1, headSha: HEAD }
    );
    expect(onY).toMatchObject({ attempts: [], reviewRequests: [], selected: { status: "missing" } });
  });

  it("keeps CI mode command handling off even when a repo opts in", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-repo-commands-ci-"));
    try {
      const event = join(root, "event.json");
      writeFileSync(event, JSON.stringify({ pull_request: { number: 1, head: { sha: HEAD } } }));
      const codex = join(root, "codex");
      writeFileSync(codex, "#!/bin/sh\nexit 0\n");
      chmodSync(codex, 0o700);
      const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "org/repo-x", GITHUB_EVENT_PATH: event, GITHUB_EVENT_NAME: "pull_request_target", PATH: root, RUNNER_TEMP: root };
      const base = configWith({ enabled: true, trustedAuthors: ["repo-maintainer"] });
      const ci = buildCiConfig(base, readCiPullContext(env), env);
      expect(resolveRepoCommandConfig(ci, "org/repo-x").enabled).toBe(false);
      expect(base.repoProfiles?.repos?.["org/repo-x"]?.commands).toEqual({ enabled: true, trustedAuthors: ["repo-maintainer"] });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("per-repo command config validation", () => {
  it("accepts the supported shapes", () => {
    expect(() => configWith({})).not.toThrow();
    expect(() => configWith({ enabled: true })).not.toThrow();
    expect(() => configWith({ trustedAuthors: [] })).not.toThrow();
    expect(() => configWith({ enabled: false, trustedAuthors: ["repo-maintainer"] })).not.toThrow();
  });

  it.each([
    ["a non-object", true, /repoProfiles\.repos\.org\/repo-x\.commands must be an object/],
    ["an array", [], /commands must be an object/],
    ["a non-boolean enabled", { enabled: "yes" }, /commands\.enabled must be a boolean/],
    ["a non-array trustedAuthors", { trustedAuthors: "repo-maintainer" }, /commands\.trustedAuthors must be an array of non-empty strings/],
    ["an empty trusted author", { trustedAuthors: [""] }, /commands\.trustedAuthors must be an array of non-empty strings/],
    ["a non-string trusted author", { trustedAuthors: [7] }, /commands\.trustedAuthors must be an array of non-empty strings/],
    ["an unknown key", { enabled: true, acknowledge: true }, /commands has unknown key "acknowledge"/],
    ["a misspelled key", { trustedAuthor: ["repo-maintainer"] }, /commands has unknown key "trustedAuthor"/]
  ])("rejects %s", (_label, value, message) => {
    expect(() => configWith(value)).toThrow(message);
  });

  it("rejects commands on org fallbacks so one entry cannot open a whole org", () => {
    expect(() => loadConfigFromObject({
      commands: globalCommands,
      repoProfiles: { enableOrgFallbacks: true, orgFallbacks: { org: { commands: { enabled: true } } } }
    })).toThrow(/repoProfiles\.orgFallbacks\.org\.commands is only supported under repoProfiles\.repos/);
  });
});
