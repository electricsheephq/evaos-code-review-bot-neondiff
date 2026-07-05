import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildGitNexusContextPacket,
  extractChangedExportedSymbols,
  parseGitNexusList,
  type GitNexusCommandRunner,
  type GitNexusContextConfig
} from "../src/gitnexus-context.js";
import { buildReviewPrompt } from "../src/zcode.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";

describe("GitNexus context packets", () => {
  const repo = "electricsheephq/evaos-code-review-bot";
  const generatedAt = "2026-07-02T00:00:00.000Z";
  const pull = pullRequest({
    number: 102,
    headSha: "d239e3b15ab26f9bdcfef25e0036e57598e1f8ce",
    baseSha: "833eaccf9403a1d33a46eb0fb38889f3571974a1"
  });

  it("parses GitNexus list output into deterministic index records", () => {
    expect(parseGitNexusList(gitnexusList([{ alias: "evaos-code-review-bot", commit: "d239e3b" }]))).toEqual([
      {
        alias: "evaos-code-review-bot",
        path: "/Volumes/LEXAR/repos/evaos-code-review-bot",
        indexedAt: "7/2/2026, 2:29:04 PM",
        commit: "d239e3b"
      }
    ]);
  });

  it("builds a missing-index degraded packet without querying GitNexus", () => {
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files: [{ filename: "src/worker.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      config: config(),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "worldos", commit: "073339d" }]),
      commandRunner: failOnQueryRunner()
    });
    const repeated = buildGitNexusContextPacket({
      repo,
      pull,
      files: [{ filename: "src/worker.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      config: config(),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "worldos", commit: "073339d" }]),
      commandRunner: failOnQueryRunner()
    });

    expect(result.ok).toBe(true);
    expect(repeated.ok).toBe(true);
    if (!result.ok || !repeated.ok) throw new Error("expected packet builds to pass");
    expect(result.packet.sha256).toBe(repeated.packet.sha256);
    expect(result.packet.gitnexus).toMatchObject({
      freshness: "missing",
      degradedMode: true
    });
    expect(result.packet.relatedContext).toEqual([]);
    expect(result.packet.omittedContext).toEqual([
      expect.objectContaining({ id: "gitnexus:index", reason: "missing_index" })
    ]);
    expect(result.packet.markdown).toContain("Current PR diff, checkout files, and GitHub metadata remain authoritative");
  });

  it("hardens the inner packet builder contract when GitNexus context is disabled", () => {
    const input = {
      repo,
      pull,
      files: [{ filename: "src/worker.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      config: config({ enabled: false }),
      generatedAt,
      commandRunner: () => {
        throw new Error("disabled GitNexus context must not invoke commands");
      }
    };
    const result = buildGitNexusContextPacket(input);
    const repeated = buildGitNexusContextPacket(input);

    expect(result.ok).toBe(true);
    expect(repeated.ok).toBe(true);
    if (!result.ok || !repeated.ok) throw new Error("expected disabled packet builds to pass");
    expect(result.packet.sha256).toBe(repeated.packet.sha256);
    expect(result.packet.gitnexus).toMatchObject({
      freshness: "missing",
      degradedMode: true,
      degradedReason: "GitNexus context is disabled by configuration."
    });
    expect(result.packet.relatedContext).toEqual([]);
    expect(result.packet.omittedContext).toContainEqual({
      id: "gitnexus:disabled",
      reason: "disabled",
      detail: "GitNexus context is disabled by configuration."
    });
  });

  it("includes bounded related context for a fresh matching index", () => {
    const runner = recordingQueryRunner({
      "src/worker.ts buildGitNexusContext reviewPull worker": "Process ReviewPull -> buildReviewPrompt -> runZCodeReview\nsrc/worker.ts coordinates review evidence writes."
    });
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files: [
        {
          filename: "src/worker.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
          changes: 3,
          patch: [
            "@@ -1,2 +1,4 @@",
            "+export function buildGitNexusContext() {",
            "+export async function reviewPull() {"
          ].join("\n")
        },
        { filename: "dist/bundle.js", status: "modified", additions: 50, deletions: 0, changes: 50 }
      ],
      config: config({ repoAliases: { [repo]: "evaos-code-review-bot" } }),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "evaos-code-review-bot", commit: pull.base.sha.slice(0, 7) }]),
      commandRunner: runner
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected packet build to pass");
    expect(result.packet.gitnexus).toMatchObject({
      alias: "evaos-code-review-bot",
      freshness: "fresh",
      degradedMode: false
    });
    expect(result.packet.relatedContext).toHaveLength(1);
    expect(result.packet.relatedContext[0]).toMatchObject({
      id: "query:src/worker.ts",
      query: "src/worker.ts buildGitNexusContext reviewPull worker"
    });
    expect(runner.calls).toEqual([
      [
        "query",
        "src/worker.ts buildGitNexusContext reviewPull worker",
        "--repo",
        "evaos-code-review-bot",
        "--limit",
        "3",
        "--max-tokens",
        "2000"
      ]
    ]);
    expect(result.packet.changedFiles.find((file) => file.path === "src/worker.ts")).toMatchObject({
      path: "src/worker.ts",
      changedExportedSymbols: ["buildGitNexusContext", "reviewPull"],
      symbolHints: ["buildGitNexusContext", "reviewPull", "worker"]
    });
    expect(result.packet.markdown).toContain("changed exports: buildGitNexusContext, reviewPull");
    expect(result.packet.omittedContext).toEqual([
      expect.objectContaining({ id: "file:dist/bundle.js", reason: "generated_path" })
    ]);
    expect(result.packet.byteEstimate).toBe(Buffer.byteLength(result.packet.markdown, "utf8"));
    expect(result.packet.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks stale indexes degraded and skips queries unless stale context is enabled", () => {
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files: [{ filename: "src/worker.ts", status: "modified" }],
      config: config({ repoAliases: { [repo]: "evaos-code-review-bot" } }),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "evaos-code-review-bot", commit: "0000000" }]),
      commandRunner: failOnQueryRunner()
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected packet build to pass");
    expect(result.packet.gitnexus).toMatchObject({
      freshness: "stale",
      degradedMode: true
    });
    expect(result.packet.relatedContext).toEqual([]);
    expect(result.packet.omittedContext).toEqual([
      expect.objectContaining({ id: "gitnexus:evaos-code-review-bot", reason: "stale_index" })
    ]);
  });

  it("extracts changed exported symbols from added patch lines", () => {
    expect(extractChangedExportedSymbols([
      "@@ -1 +1 @@",
      "+export function plainFunction() {}",
      "+export async function asyncFunction() {}",
      "+export const constantValue = 1;",
      "+export type PacketShape = {};",
      "+export interface PacketContract {}",
      "+export class PacketBuilder {}",
      "+export enum PacketMode {}",
      "+export { localName as exportedName, directName };",
      "+++ b/src/file.ts",
      "-export function oldSymbol() {}"
    ].join("\n"))).toEqual([
      "PacketBuilder",
      "PacketContract",
      "PacketMode",
      "PacketShape",
      "asyncFunction",
      "constantValue",
      "localName",
      "plainFunction"
    ]);
  });

  it("drops related context before exceeding the packet byte budget", () => {
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files: [
        { filename: "src/worker.ts", status: "modified" },
        { filename: "src/zcode.ts", status: "modified" }
      ],
      config: config({
        repoAliases: { [repo]: "evaos-code-review-bot" },
        maxPacketBytes: 1_300,
        maxCommandOutputBytes: 2_000
      }),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "evaos-code-review-bot", commit: pull.head.sha.slice(0, 7) }]),
      commandRunner: queryRunner({
        "src/worker.ts worker": "worker ".repeat(400),
        "src/zcode.ts zcode": "zcode ".repeat(400)
      })
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected packet build to pass");
    expect(result.packet.byteEstimate).toBeLessThanOrEqual(1_300);
    expect(result.packet.omittedContext.some((item) => item.reason === "budget_exceeded")).toBe(true);
  });

  it("fails closed and redacts evidence when GitNexus output contains secret-like text", () => {
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files: [{ filename: "src/worker.ts", status: "modified" }],
      config: config({ repoAliases: { [repo]: "evaos-code-review-bot" } }),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "evaos-code-review-bot", commit: pull.head.sha.slice(0, 7) }]),
      commandRunner: queryRunner({
        "src/worker.ts worker": "Leaked token ghp_fake_token in an indexed comment."
      })
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected packet build to fail closed");
    expect(result.error).toContain("secret-like");
    expect(JSON.stringify(result)).not.toContain("ghp_fake_token");
    expect(JSON.stringify(result)).toContain("[redacted-secret]");
  });

  it("adds GitNexus context to the review prompt as advisory context", () => {
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files: [{ filename: "src/worker.ts", status: "modified" }],
      config: config({ repoAliases: { [repo]: "evaos-code-review-bot" } }),
      generatedAt,
      gitnexusListText: gitnexusList([{ alias: "evaos-code-review-bot", commit: pull.head.sha.slice(0, 7) }]),
      commandRunner: queryRunner({ "src/worker.ts worker": "worker review flow" })
    });
    if (!result.ok) throw new Error("expected packet build to pass");

    const prompt = buildReviewPrompt({
      repo,
      pull,
      files: [{ filename: "src/worker.ts", patch: "@@ -1 +1 @@\n-old\n+new" }],
      gitnexusContextPacket: result.packet
    });

    expect(prompt).toContain("GitNexus context packet (advisory; feature-flagged context):");
    expect(prompt).toContain(result.packet.sha256);
    expect(prompt).toContain("GitNexus freshness: fresh; degraded=false");
    expect(prompt).toContain("Current PR diff, checkout files, and GitHub metadata remain authoritative");
  });

  it("loads default-off GitNexus context config", () => {
    const loaded = loadConfig();

    expect(loaded.gitnexusContext).toMatchObject({
      enabled: false,
      packetVersion: "gitnexus-context-packet-v0.1",
      includeStaleContext: false
    });
  });
});

function config(overrides: Partial<GitNexusContextConfig> = {}): GitNexusContextConfig {
  return {
    enabled: true,
    packetVersion: "gitnexus-context-packet-v0.1",
    maxPacketBytes: 40_000,
    maxRelatedItems: 8,
    queryLimit: 3,
    commandTimeoutMs: 10_000,
    maxCommandOutputBytes: 8_000,
    includeStaleContext: false,
    repoAliases: {},
    generatedPathPatterns: ["dist/**", "build/**", "coverage/**", "Library/**", "Temp/**", "**/*.min.js", "**/*.bundle.js", "**/*.lock"],
    ...overrides
  };
}

function pullRequest(input: { number: number; headSha: string; baseSha: string }): PullRequestSummary {
  return {
    number: input.number,
    title: "Test PR",
    draft: false,
    head: {
      sha: input.headSha,
      ref: "feature/test",
      repo: { full_name: "electricsheephq/evaos-code-review-bot" }
    },
    base: {
      sha: input.baseSha,
      ref: "main",
      repo: { full_name: "electricsheephq/evaos-code-review-bot" }
    },
    html_url: `https://github.com/electricsheephq/evaos-code-review-bot/pull/${input.number}`
  };
}

function gitnexusList(records: Array<{ alias: string; commit: string }>): string {
  return [
    "",
    `  Indexed Repositories (${records.length})`,
    "",
    ...records.flatMap((record) => [
      `  ${record.alias}`,
      `    Path:    /Volumes/LEXAR/repos/${record.alias}`,
      "    Indexed: 7/2/2026, 2:29:04 PM",
      `    Commit:  ${record.commit}`,
      "    Stats:   10 files, 20 symbols, 30 edges",
      "    Clusters:   4",
      "    Processes:  5",
      ""
    ])
  ].join("\n");
}

function queryRunner(outputs: Record<string, string>): GitNexusCommandRunner {
  return (args) => {
    if (args[0] !== "query") return { ok: true, stdout: "" };
    const query = args[1] ?? "";
    return {
      ok: true,
      stdout: outputs[query] ?? `No context for ${query}.`
    };
  };
}

function recordingQueryRunner(outputs: Record<string, string>): GitNexusCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitNexusCommandRunner & { calls: string[][] } = (args, options) => {
    if (args[0] === "query") calls.push([...args]);
    return queryRunner(outputs)(args, options);
  };
  runner.calls = calls;
  return runner;
}

function failOnQueryRunner(): GitNexusCommandRunner {
  return (args) => {
    if (args[0] === "query") throw new Error("query should not be called");
    return { ok: true, stdout: "" };
  };
}
