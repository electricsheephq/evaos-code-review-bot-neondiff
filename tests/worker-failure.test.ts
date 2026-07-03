import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitNexusCommandRunner } from "../src/gitnexus-context.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import {
  buildRepoMemoryContext,
  buildGitNexusContext,
  buildGitHubRelatedContext,
  buildSkillPackContext,
  classifyProviderError,
  createGitHubRelatedContextReader,
  isSuccessfulRetryStatus,
  localDateFolder,
  prepareFailedHeadRetry,
  providerCooldownDurationMs,
  recordFailedReview,
  recordProviderRateLimitCooldownIfNeeded,
  restoreFailedRetryRowIfNeeded,
  retryFailedHeadWithDeps,
  retryProviderCooldownsWithDeps,
  reviewPull,
  runWithProviderRetry
} from "../src/worker.js";

describe("worker review failures", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records a failed head with redacted evidence so duplicate suppression can hold", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-failure-"));
    roots.push(root);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    const pull = pullSummary(1222, "head-failed");

    recordFailedReview({
      config,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error: new Error("ZCode failed before completion: spawnSync node ETIMEDOUT with ghp_1234567890abcdefghijklmnopqrstuvwx")
    });

    expect(state.hasProcessed("electricsheephq/WorldOS", 1222, "head-failed")).toBe(true);
    const evidence = readFileSync(
      join(root, "evidence", localDateFolder(), "electricsheephq__WorldOS", "pr-1222", "head-failed", "review-error.json"),
      "utf8"
    );
    expect(evidence).toContain("ETIMEDOUT");
    expect(evidence).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
    state.close();
  });

  it("records provider rate limits as cooldown skips instead of hard failures", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-"));
    roots.push(root);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    const pull = pullSummary(1234, "head-rate-limit");

    const handled = recordProviderRateLimitCooldownIfNeeded({
      config,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      error: new Error("ProviderBusinessError: [1302][Rate limit reached for requests]"),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(handled).toBe(true);
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1234, "head-rate-limit")).toMatchObject({
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2026-07-01T00:01:30.000Z; reason=provider_request_rate_limit"
    });
    expect(state.getActiveRepoProviderCooldown("electricsheephq/WorldOS", new Date("2026-07-01T00:01:00.000Z"))).toMatchObject({
      reason: "provider_request_rate_limit"
    });
    state.close();
  });

  it("degrades oversized repo-memory packets to no-memory context", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-repo-memory-budget-"));
    roots.push(root);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const evidenceDir = join(root, "evidence");
    const fingerprint = `finding:${"b".repeat(64)}`;
    mkdirSync(evidenceDir, { recursive: true });
    const config: BotConfig = {
      ...minimalConfig(root),
      repoMemory: {
        enabled: true,
        memoryRoot: join(root, "memory"),
        packetVersion: "repo-memory-packet-v0.1",
        maxPacketBytes: 10,
        maxStateNotes: 10,
        includeStaleNotes: false
      }
    };
    state.recordRepoMemoryNote({
      noteId: "fp-large",
      repo: "electricsheephq/WorldOS",
      kind: "false_positive",
      title: "Large false positive",
      body: "An oversized advisory memory packet must not abort the review.",
      source: "test",
      fingerprint,
      expiresAt: "2026-08-01T00:00:00.000Z",
      now: new Date("2026-07-02T00:00:00.000Z")
    });

    const context = buildRepoMemoryContext({
      config,
      state,
      repo: "electricsheephq/WorldOS",
      evidenceDir
    });

    expect(context.packet).toBeUndefined();
    expect(context.falsePositiveFingerprints).toEqual([fingerprint]);
    const error = JSON.parse(readFileSync(join(evidenceDir, "repo-memory-packet-error.json"), "utf8"));
    expect(error).toMatchObject({
      ok: false,
      error: expect.stringContaining("maxPacketBytes")
    });
    expect(error.excluded).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "packet:markdown", reason: "budget_exceeded" })
    ]));
    state.close();
  });

  it("fails closed and redacts evidence when repo-memory sources contain secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-repo-memory-secret-"));
    roots.push(root);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const evidenceDir = join(root, "evidence");
    const memoryDir = join(root, "memory", "electricsheephq", "WorldOS");
    const secretValue = ["123456789012", "345678901234"].join("");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "repo-memory.md"), `## Bad Memory\napi_key=${secretValue}\n`);
    const config: BotConfig = {
      ...minimalConfig(root),
      repoMemory: {
        enabled: true,
        memoryRoot: join(root, "memory"),
        packetVersion: "repo-memory-packet-v0.1",
        maxPacketBytes: 12_000,
        maxStateNotes: 10,
        includeStaleNotes: false
      }
    };

    expect(() =>
      buildRepoMemoryContext({
        config,
        state,
        repo: "electricsheephq/WorldOS",
        evidenceDir
      })
    ).toThrow(/Repo memory packet failed closed/);
    const error = readFileSync(join(evidenceDir, "repo-memory-packet-error.json"), "utf8");
    expect(error).toContain("[redacted-secret]");
    expect(error).not.toContain(secretValue);
    state.close();
  });

  it("fails closed and redacts evidence when skill-pack packet metadata contains secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-skill-pack-secret-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    const skillRoot = join(root, "skills");
    const secretValue = "ghp_123456789012345678901234";
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(join(skillRoot, "review.md"), "Prefer current diff evidence.");
    const config: BotConfig = {
      ...minimalConfig(root),
      skillPacks: {
        enabled: true,
        packetVersion: `skill-pack-context-packet-v0.1-${secretValue}`,
        skillRoot,
        allowlist: [{ id: "review", path: "review.md" }],
        maxSkillBytes: 4_000,
        maxPacketBytes: 12_000
      }
    };

    expect(() =>
      buildSkillPackContext({
        config,
        evidenceDir
      })
    ).toThrow(/Skill-pack context packet failed closed/);
    const error = readFileSync(join(evidenceDir, "skill-pack-context-packet-error.json"), "utf8");
    expect(error).toContain("[redacted-secret]");
    expect(error).not.toContain(secretValue);
  });

  it("keeps false-positive suppression notes from starving prompt memory notes", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-repo-memory-split-"));
    roots.push(root);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const evidenceDir = join(root, "evidence");
    const fingerprint = `finding:${"c".repeat(64)}`;
    mkdirSync(evidenceDir, { recursive: true });
    const config: BotConfig = {
      ...minimalConfig(root),
      repoMemory: {
        enabled: true,
        memoryRoot: join(root, "memory"),
        packetVersion: "repo-memory-packet-v0.1",
        maxPacketBytes: 12_000,
        maxStateNotes: 1,
        includeStaleNotes: false
      }
    };
    state.recordRepoMemoryNote({
      noteId: "policy-survives",
      repo: "electricsheephq/WorldOS",
      kind: "policy_note",
      title: "Policy survives",
      body: "Prompt memory should still include current policy notes.",
      source: "test",
      now: new Date("2026-07-02T00:00:00.000Z")
    });
    state.recordRepoMemoryNote({
      noteId: "fp-newer",
      repo: "electricsheephq/WorldOS",
      kind: "false_positive",
      title: "Newer false positive",
      body: "Suppression notes use a separate read budget.",
      source: "test",
      fingerprint,
      expiresAt: "2026-07-09T00:00:00.000Z",
      now: new Date("2026-07-02T00:01:00.000Z")
    });

    const context = buildRepoMemoryContext({
      config,
      state,
      repo: "electricsheephq/WorldOS",
      evidenceDir
    });

    expect(context.falsePositiveFingerprints).toEqual([fingerprint]);
    expect(context.packet?.sources.map((source) => source.id)).toContain("policy-survives");
    expect(context.packet?.markdown).toContain("Prompt memory should still include current policy notes.");
    state.close();
  });

  it("writes GitNexus context packet evidence when the provider degrades cleanly", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-gitnexus-context-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const config: BotConfig = {
      ...minimalConfig(root),
      gitnexusContext: {
        enabled: true,
        packetVersion: "gitnexus-context-packet-v0.1",
        maxPacketBytes: 12_000,
        maxRelatedItems: 4,
        queryLimit: 2,
        commandTimeoutMs: 1_000,
        maxCommandOutputBytes: 2_000,
        includeStaleContext: false,
        repoAliases: {},
        generatedPathPatterns: ["dist/**"]
      }
    };

    const context = buildGitNexusContext({
      config,
      repo: "electricsheephq/WorldOS",
      pull: pullSummary(1128, "head", "base"),
      files: [{ filename: "src/worker.ts", status: "modified" }],
      evidenceDir,
      gitnexusListText: workerGitNexusList([{ alias: "evaos-code-review-bot", commit: "d239e3b" }]),
      commandRunner: failOnGitNexusQueryRunner()
    });

    expect(context.packet).toBeDefined();
    expect(context.packet?.gitnexus).toMatchObject({
      freshness: "missing",
      degradedMode: true
    });
    expect(readFileSync(join(evidenceDir, "gitnexus-context-packet.md"), "utf8")).toContain("Degraded mode: true");
    const evidence = JSON.parse(readFileSync(join(evidenceDir, "gitnexus-context-packet.json"), "utf8"));
    expect(evidence).toMatchObject({
      ok: true,
      packet: {
        gitnexus: {
          freshness: "missing",
          degradedMode: true
        }
      }
    });
  });

  it("degrades over-budget GitNexus context to no context packet", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-gitnexus-budget-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    mkdirSync(evidenceDir, { recursive: true });
    const config: BotConfig = {
      ...minimalConfig(root),
      gitnexusContext: {
        enabled: true,
        packetVersion: "gitnexus-context-packet-v0.1",
        maxPacketBytes: 10,
        maxRelatedItems: 4,
        queryLimit: 2,
        commandTimeoutMs: 1_000,
        maxCommandOutputBytes: 2_000,
        includeStaleContext: false,
        repoAliases: {},
        generatedPathPatterns: []
      }
    };

    const context = buildGitNexusContext({
      config,
      repo: "electricsheephq/WorldOS",
      pull: pullSummary(1128, "head", "base"),
      files: [{ filename: "src/worker.ts", status: "modified" }],
      evidenceDir,
      gitnexusListText: workerGitNexusList([{ alias: "worldos", commit: "base" }]),
      commandRunner: queryRunner({ "src/worker.ts worker": "worker context" })
    });

    expect(context.packet).toBeUndefined();
    const error = JSON.parse(readFileSync(join(evidenceDir, "gitnexus-context-packet-error.json"), "utf8"));
    expect(error).toMatchObject({
      ok: false,
      error: expect.stringContaining("maxPacketBytes")
    });
    expect(error.omittedContext).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "packet:markdown", reason: "budget_exceeded" })
    ]));
  });

  it("fails closed and redacts evidence when GitNexus context contains secrets", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-gitnexus-secret-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    const secretValue = "ghp_123456789012345678901234";
    mkdirSync(evidenceDir, { recursive: true });
    const config: BotConfig = {
      ...minimalConfig(root),
      gitnexusContext: {
        enabled: true,
        packetVersion: "gitnexus-context-packet-v0.1",
        maxPacketBytes: 12_000,
        maxRelatedItems: 4,
        queryLimit: 2,
        commandTimeoutMs: 1_000,
        maxCommandOutputBytes: 2_000,
        includeStaleContext: false,
        repoAliases: {},
        generatedPathPatterns: []
      }
    };

    expect(() =>
      buildGitNexusContext({
        config,
        repo: "electricsheephq/WorldOS",
        pull: pullSummary(1128, "b".repeat(40), "a".repeat(40)),
        files: [{ filename: "src/worker.ts", status: "modified" }],
        evidenceDir,
        gitnexusListText: workerGitNexusList([{ alias: "worldos", commit: "a".repeat(7) }]),
        commandRunner: queryRunner({ "src/worker.ts worker": `Leaked ${secretValue}` })
      })
    ).toThrow(/GitNexus context packet failed closed/);
    const error = readFileSync(join(evidenceDir, "gitnexus-context-packet-error.json"), "utf8");
    expect(error).toContain("[redacted-secret]");
    expect(error).not.toContain(secretValue);
  });

  it("skips GitHub related context evidence when disabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-github-related-disabled-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    mkdirSync(evidenceDir, { recursive: true });

    const context = await buildGitHubRelatedContext({
      config: minimalConfig(root),
      github: githubRelatedReader({
        "electricsheephq/WorldOS#12": { number: 12, title: "Should not be read", state: "open", html_url: "https://github.test/WorldOS/issues/12" }
      }),
      repo: "electricsheephq/WorldOS",
      pull: pullSummary(1128, "head", "base", { body: "Closes #12" }),
      evidenceDir
    });

    expect(context.packet).toBeUndefined();
    expect(() => readFileSync(join(evidenceDir, "github-related-context-packet.json"), "utf8")).toThrow();
  });

  it("writes GitHub related context packet evidence when enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-github-related-"));
    roots.push(root);
    const evidenceDir = join(root, "evidence");
    const secretValue = "ghp_123456789012345678901234";
    mkdirSync(evidenceDir, { recursive: true });
    const config: BotConfig = {
      ...minimalConfig(root),
      githubRelatedContext: {
        enabled: true,
        packetVersion: "github-related-context-packet-v0.1",
        maxRelatedItems: 4,
        maxTitleChars: 120,
        maxBodyBytes: 200,
        maxPacketBytes: 12_000,
        requestTimeoutMs: 1_000,
        includeCrossRepoRefs: false
      }
    };

    const context = await buildGitHubRelatedContext({
      config,
      github: githubRelatedReader({
        "electricsheephq/WorldOS#12": {
          number: 12,
          title: `Linked issue ${secretValue}`,
          state: "closed",
          html_url: "https://github.test/electricsheephq/WorldOS/issues/12",
          labels: [{ name: "regression" }],
          body: "Prior failure context for the current diff."
        }
      }),
      repo: "electricsheephq/WorldOS",
      pull: pullSummary(1128, "head", "base", { body: "Closes #12" }),
      evidenceDir
    });

    expect(context.packet).toBeDefined();
    expect(context.packet?.references[0]).toMatchObject({
      repo: "electricsheephq/WorldOS",
      number: 12,
      labels: ["regression"]
    });
    const json = readFileSync(join(evidenceDir, "github-related-context-packet.json"), "utf8");
    const markdown = readFileSync(join(evidenceDir, "github-related-context-packet.md"), "utf8");
    expect(json).toContain("[redacted-secret]");
    expect(markdown).toContain("[redacted-secret]");
    expect(json).not.toContain(secretValue);
    expect(markdown).not.toContain(secretValue);
    expect(markdown).toContain("Do not post findings solely because related GitHub context suggests risk.");
  });

  it("uses an aborting GitHub client for runtime related-context reads", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-github-related-timeout-"));
    roots.push(root);
    const config: BotConfig = {
      ...minimalConfig(root),
      github: {
        token: "fallback-token"
      },
      githubRelatedContext: {
        enabled: true,
        packetVersion: "github-related-context-packet-v0.1",
        maxRelatedItems: 4,
        maxTitleChars: 120,
        maxBodyBytes: 200,
        maxPacketBytes: 12_000,
        requestTimeoutMs: 5,
        includeCrossRepoRefs: false
      }
    };

    const previousFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason instanceof Error ? init.signal.reason : new Error("aborted"));
      });
    })) as typeof fetch;
    try {
      const reader = createGitHubRelatedContextReader(config, githubRelatedReader({}));
      const startedAt = Date.now();
      await expect(reader.getIssueOrPull("owner/repo", 12)).rejects.toThrow(/timed out|aborted/i);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("classifies provider throttle, overload, and true quota separately", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-classify-"));
    roots.push(root);
    const config = minimalConfig(root);
    const rateLimit = classifyProviderError(new Error("ProviderBusinessError: [1302][Rate limit reached for requests] providerRequestId: 'req-1'"));
    const overload = classifyProviderError(new Error("ProviderBusinessError: [1305][The service may be temporarily overloaded, please try again later]"));
    const quota = classifyProviderError(new Error("ProviderBusinessError: [1310][Weekly/Monthly Limit Exhausted]"));

    expect(rateLimit).toMatchObject({
      category: "request_rate_limit",
      providerCode: "1302",
      reason: "provider_request_rate_limit",
      retryable: true,
      cooldown: true
    });
    expect(overload).toMatchObject({
      category: "overloaded",
      providerCode: "1305",
      reason: "provider_overloaded",
      retryable: true,
      cooldown: true
    });
    expect(quota).toMatchObject({
      category: "quota_exhausted",
      providerCode: "1310",
      reason: "provider_quota_exhausted",
      retryable: false,
      cooldown: true
    });
    expect(providerCooldownDurationMs(config, rateLimit)).toBe(90_000);
    expect(providerCooldownDurationMs(config, overload)).toBe(2 * 60_000);
    expect(providerCooldownDurationMs(config, quota)).toBe(30 * 60_000);
  });

  it("retries transient provider throttles before surfacing failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    let attempts = 0;

    const result = await runWithProviderRetry({
      config,
      evidenceDir: join(root, "evidence"),
      operation: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("ProviderBusinessError: [1302][Rate limit reached for requests] providerRequestId: 'req-retry'");
        }
        return "ok";
      }
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    const evidence = JSON.parse(readFileSync(join(root, "evidence", "provider-retry.json"), "utf8"));
    expect(evidence).toMatchObject([
      {
        attempt: 1,
        category: "request_rate_limit",
        providerCode: "1302",
        reason: "provider_request_rate_limit",
        retryable: true
      },
      {
        attempt: 2,
        category: "none",
        reason: "success_after_retry",
        final: true
      }
    ]);
  });

  it("records Retry-After hints in provider retry evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-retry-after-"));
    roots.push(root);
    const config = minimalConfig(root);
    let attempts = 0;

    const result = await runWithProviderRetry({
      config,
      evidenceDir: join(root, "evidence"),
      operation: () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("ProviderBusinessError: [1305][temporarily overloaded] retry-after: 0.001");
        }
        return "ok";
      }
    });

    expect(result).toBe("ok");
    const evidence = JSON.parse(readFileSync(join(root, "evidence", "provider-retry.json"), "utf8"));
    expect(evidence[0]).toMatchObject({
      attempt: 1,
      category: "overloaded",
      providerCode: "1305",
      retryAfterMs: 1,
      nextDelayMs: 1
    });
  });

  it("does not retry true quota exhaustion provider errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-no-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    let attempts = 0;

    await expect(runWithProviderRetry({
      config,
      evidenceDir: join(root, "evidence"),
      operation: () => {
        attempts += 1;
        throw new Error("ProviderBusinessError: [1310][Weekly/Monthly Limit Exhausted]");
      }
    })).rejects.toThrow("1310");

    expect(attempts).toBe(1);
    const evidence = JSON.parse(readFileSync(join(root, "evidence", "provider-retry.json"), "utf8"));
    expect(evidence[0]).toMatchObject({
      attempt: 1,
      category: "quota_exhausted",
      providerCode: "1310",
      reason: "provider_quota_exhausted",
      retryable: false,
      final: true
    });
  });

  it("prepares exactly one failed current head for retry without deleting the failure row", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "head-retry",
      status: "failed",
      error: "transient API timeout"
    });
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "other-head",
      status: "failed",
      error: "separate failure"
    });

    const result = prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "head-retry",
      livePull: pullSummary(1223, "head-retry")
    });
    expect(result).toMatchObject({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1223,
      headSha: "head-retry"
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1223, "head-retry")).toMatchObject({
      status: "failed"
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1223, "other-head")).toMatchObject({
      status: "failed"
    });
    state.close();
  });

  it("refuses retry when the requested failed head is stale", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-stale-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1224,
      headSha: "old-head",
      status: "failed",
      error: "transient API timeout"
    });
    expect(() => prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1224,
      headSha: "old-head",
      livePull: pullSummary(1224, "new-head")
    })).toThrow("Refusing retry for stale head");

    expect(state.getProcessedReview("electricsheephq/WorldOS", 1224, "old-head")).toMatchObject({
      status: "failed"
    });
    state.close();
  });

  it("refuses retry when the current head is not failed", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-nonfailed-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1225,
      headSha: "head-posted",
      status: "posted",
      event: "COMMENT"
    });
    expect(() => prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1225,
      headSha: "head-posted",
      livePull: pullSummary(1225, "head-posted")
    })).toThrow("status is posted, not failed/provider-cooldown");
    state.close();
  });

  it("allows retry for provider-cooldown skipped heads", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-retry-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1235,
      headSha: "head-provider-cooldown",
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2026-07-01T00:15:00.000Z; reason=provider_rate_limit"
    });

    expect(prepareFailedHeadRetry({
      state,
      repo: "electricsheephq/WorldOS",
      pullNumber: 1235,
      headSha: "head-provider-cooldown",
      livePull: pullSummary(1235, "head-provider-cooldown")
    })).toMatchObject({
      previousError: "provider_rate_limit_cooldown_until=2026-07-01T00:15:00.000Z; reason=provider_rate_limit"
    });
    state.close();
  });

  it("does not retry active provider-cooldown heads in the expired-only bulk path", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-active-bulk-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1236, "head-active-provider-cooldown");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2999-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });
    let attempts = 0;

    const result = await retryProviderCooldownsWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        dryRun: true,
        expiredOnly: true
      },
      reviewPullImpl: async () => {
        attempts += 1;
        return "reviewed";
      }
    });

    expect(result).toMatchObject({
      ok: true,
      candidates: 0,
      attempted: 0
    });
    expect(attempts).toBe(0);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("provider_rate_limit_cooldown_until=2999-01-01T00:00:00.000Z")
    });
    state.close();
  });

  it("does not immediately retry expired provider-cooldown heads while a global provider cooldown is active", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-global-active-bulk-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1236, "head-expired-provider-cooldown");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });
    state.recordRepoProviderCooldown({
      repo: "100yenadmin/evaOS-GUI",
      cooldownUntil: new Date("2999-01-01T00:00:00.000Z"),
      reason: "provider_request_rate_limit"
    });
    let attempts = 0;

    const result = await retryProviderCooldownsWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        dryRun: false,
        expiredOnly: true
      },
      reviewPullImpl: async () => {
        attempts += 1;
        return "reviewed";
      }
    });

    expect(result).toMatchObject({
      ok: true,
      candidates: 1,
      attempted: 0,
      summary: {
        remainedCooldown: 1,
        failed: 0
      }
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        repo: "electricsheephq/WorldOS",
        pullNumber: 1236,
        headSha: "head-expired-provider-cooldown",
        status: "skipped_provider_cooldown"
      })
    ]);
    expect(attempts).toBe(0);
    state.close();
  });

  it("retries expired provider-cooldown heads and keeps dry-runs retryable as cooldown skips", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-expired-bulk-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1237, "head-expired-provider-cooldown");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });

    const result = await retryProviderCooldownsWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        dryRun: true,
        expiredOnly: true
      },
      reviewPullImpl: async ({ state: retryState, repo, pull: retryPull }) => {
        retryState.recordProcessed({
          repo,
          pullNumber: retryPull.number,
          headSha: retryPull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return "reviewed";
      }
    });

    expect(result.summary).toMatchObject({
      dryRun: 1,
      failed: 0,
      remainedCooldown: 0
    });
    expect(result.results).toEqual([
      expect.objectContaining({
        pullNumber: 1237,
        headSha: "head-expired-provider-cooldown",
        status: "dry_run"
      })
    ]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z")
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)?.error).toContain("retry_dry_run");
    state.close();
  });

  it("skips stale expired provider-cooldown candidates and continues bulk retrying current heads", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-stale-bulk-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const currentPull = pullSummary(1240, "head-current-provider-cooldown");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: currentPull.number,
      headSha: "head-stale-provider-cooldown",
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: currentPull.number,
      headSha: currentPull.head.sha,
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });
    let attempts = 0;

    const result = await retryProviderCooldownsWithDeps({
      config,
      github: retryGithub(currentPull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        dryRun: true,
        expiredOnly: true
      },
      reviewPullImpl: async ({ state: retryState, repo, pull: retryPull }) => {
        attempts += 1;
        retryState.recordProcessed({
          repo,
          pullNumber: retryPull.number,
          headSha: retryPull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return "reviewed";
      }
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      skippedStaleHead: 1,
      dryRun: 1,
      failed: 0
    });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        headSha: "head-stale-provider-cooldown",
        status: "skipped_stale_head"
      }),
      expect.objectContaining({
        headSha: "head-current-provider-cooldown",
        status: "dry_run"
      })
    ]));
    expect(attempts).toBe(1);
    const staleRetryRow = state.getProcessedReview("electricsheephq/WorldOS", currentPull.number, "head-stale-provider-cooldown");
    expect(staleRetryRow).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("provider_cooldown_retry_stale_head")
    });
    expect(staleRetryRow?.error).toContain("retry_did_not_review=skipped_stale_head");
    expect(staleRetryRow?.error).not.toMatch(/^provider_rate_limit_cooldown_until=/);
    expect(state.listProviderCooldownReviews({ expiredOnly: true }).map((row) => row.headSha)).toEqual([
      "head-current-provider-cooldown"
    ]);
    expect(state.getProcessedReview("electricsheephq/WorldOS", currentPull.number, currentPull.head.sha)).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("retry_dry_run")
    });
    state.close();
  });

  it("records a renewed provider cooldown when an expired bulk retry is still rate-limited", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-renewed-bulk-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1238, "head-renewed-provider-cooldown");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });
    const queueJob = state.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha
    }).job;
    state.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "running",
      clearLease: false,
      lastError: "retry_started"
    });

    const result = await retryProviderCooldownsWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        dryRun: false,
        expiredOnly: true
      },
      reviewPullImpl: async () => {
        throw new Error("ProviderBusinessError: [1302][Rate limit reached for requests]");
      }
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      remainedCooldown: 1,
      failed: 0
    });
    expect(result.results[0]).toMatchObject({
      status: "skipped_provider_cooldown"
    });
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("provider_rate_limit_cooldown_until=")
    });
    expect(state.getReviewQueueJob(queueJob.jobId)).toMatchObject({
      state: "provider_deferred",
      nextEligibleAt: expect.stringMatching(/T/),
      lastError: expect.stringContaining("provider_rate_limit_cooldown_until=")
    });
    state.close();
  });

  it("skips closed provider-cooldown retry candidates without running review work", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-cooldown-closed-bulk-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1239, "head-closed-provider-cooldown", "base", {
      state: "closed",
      mergedAt: "2026-07-01T06:00:00Z"
    });
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2000-01-01T00:00:00.000Z; reason=provider_rate_limit"
    });
    let attempts = 0;

    const result = await retryProviderCooldownsWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        dryRun: false,
        expiredOnly: true
      },
      reviewPullImpl: async () => {
        attempts += 1;
        return "reviewed";
      }
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({
      skippedClosed: 1,
      failed: 0
    });
    expect(result.results[0]).toMatchObject({
      status: "skipped_closed"
    });
    expect(attempts).toBe(0);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("closed_pr_retry_skip: state=closed; merged_at=2026-07-01T06:00:00Z")
    });
    state.close();
  });

  it("preserves the failed row when retry review work is skipped for capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-capacity-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1226, "head-capacity");
    const budget = new ReviewRunBudget(1);
    expect(budget.tryStart()).toBe(true);
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1226,
      headSha: "head-capacity",
      status: "failed",
      error: "transient API timeout"
    });

    await expect(reviewPull({
      config,
      github: {} as unknown as GitHubApi,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false,
      budget,
      processedHeadPolicy: "retry_failed_head"
    })).resolves.toBe("skipped_capacity");
    expect(state.getProcessedReview("electricsheephq/WorldOS", 1226, "head-capacity")).toMatchObject({
      status: "failed"
    });
    budget.finish();
    state.close();
  });

  it("skips activation-baselined heads before fetching commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-baseline-command-skip-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1230, "head-baselined");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    let issueCommentReads = 0;

    const result = await reviewPull({
      config,
      github: {
        listIssueComments: async () => {
          issueCommentReads += 1;
          throw new Error("activation-baselined heads should not read issue comments");
        },
        listPullFiles: async () => {
          throw new Error("activation-baselined heads should not fetch files");
        }
      } as unknown as GitHubApi,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false
    });

    expect(result).toBe("skipped_processed");
    expect(issueCommentReads).toBe(0);
    state.close();
  });

  it("skips pre-activation PRs with new heads before fetching commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-preactivation-command-skip-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.commands = {
      enabled: true,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: ["100yenadmin"],
      acknowledge: false
    };
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1231, "new-head-on-old-pr", "base", { createdAt: "2026-06-30T05:34:43Z" });
    state.recordRepoActivation("electricsheephq/WorldOS", "2026-07-02T16:58:09.555Z");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: "old-baselined-head",
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    let issueCommentReads = 0;

    const result = await reviewPull({
      config,
      github: {
        listIssueComments: async () => {
          issueCommentReads += 1;
          throw new Error("pre-activation PR heads should not read issue comments");
        },
        listPullFiles: async () => {
          throw new Error("pre-activation PR heads should not fetch files");
        }
      } as unknown as GitHubApi,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false
    });

    expect(result).toBe("skipped_processed");
    expect(issueCommentReads).toBe(0);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "skipped",
      error: "activation_baseline_existing_head"
    });
    expect(state.getReviewReadiness("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      state: "skipped",
      reason: "activation_baseline_existing_head"
    });
    state.close();
  });

  it("restores a failed row after a retry dry-run records dry_run", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-dry-run-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const retryTarget = {
      repo: "electricsheephq/WorldOS",
      pullNumber: 1227,
      headSha: "head-dry-run",
      previousStatus: "failed" as const,
      previousError: "transient API timeout"
    };
    state.recordProcessed({
      repo: retryTarget.repo,
      pullNumber: retryTarget.pullNumber,
      headSha: retryTarget.headSha,
      status: "dry_run",
      event: "COMMENT"
    });

    restoreFailedRetryRowIfNeeded({ state, retryTarget, reason: "retry_dry_run" });

    expect(state.getProcessedReview(retryTarget.repo, retryTarget.pullNumber, retryTarget.headSha)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("retry_dry_run")
    });
    state.close();
  });

  it("does not rewrite an already failed retry row for intentional skip statuses", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-skip-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const retryTarget = {
      repo: "electricsheephq/WorldOS",
      pullNumber: 1228,
      headSha: "head-skip",
      previousStatus: "failed" as const,
      previousError: "original failure"
    };
    state.recordProcessed({
      repo: retryTarget.repo,
      pullNumber: retryTarget.pullNumber,
      headSha: retryTarget.headSha,
      status: "failed",
      error: retryTarget.previousError
    });

    restoreFailedRetryRowIfNeeded({ state, retryTarget, reason: "retry_did_not_review=skipped_command_stop" });

    expect(state.getProcessedReview(retryTarget.repo, retryTarget.pullNumber, retryTarget.headSha)).toMatchObject({
      status: "failed",
      error: "original failure"
    });
    state.close();
  });

  it("keeps a failed row after a retry dry-run reaches the reviewed path", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-orchestrator-dry-run-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1229, "head-retry-dry-run");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });

    const result = await retryFailedHeadWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: true,
        useZCode: false
      },
      reviewPullImpl: async ({ state: retryState, repo, pull: retryPull }) => {
        retryState.recordProcessed({
          repo,
          pullNumber: retryPull.number,
          headSha: retryPull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return "reviewed";
      }
    });

    expect(result.status).toBe("dry_run");
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("original timeout; retry_dry_run")
    });
    state.close();
  });

  it("keeps a posted row after a live retry successfully posts a review", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-orchestrator-posted-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1230, "head-retry-posted");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });

    const result = await retryFailedHeadWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: async ({ state: retryState, repo, pull: retryPull }) => {
        retryState.recordProcessed({
          repo,
          pullNumber: retryPull.number,
          headSha: retryPull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1230#pullrequestreview-1"
        });
        return "reviewed";
      }
    });

    expect(result.status).toBe("reviewed");
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "posted",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1230#pullrequestreview-1"
    });
    state.close();
  });

  it("preserves original failure context when retry review work throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-orchestrator-throw-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1231, "head-retry-throw");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });

    const result = await retryFailedHeadWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: async () => {
        throw new Error("second timeout");
      }
    });

    expect(result.status).toBe("failed");
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: "original timeout; retry_error=second timeout"
    });
    state.close();
  });

  it("restores a failed row after real reviewPull records a stale-head skip", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-real-stale-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1232, "head-retry-stale", "base-original");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });
    let getPullCalls = 0;
    const github = {
      getPull: async () => {
        getPullCalls += 1;
        return getPullCalls === 1 ? pull : pullSummary(pull.number, pull.head.sha, "base-new");
      },
      listIssueComments: async () => [],
      listPullFiles: async () => {
        throw new Error("stale retry should not fetch files");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    const result = await retryFailedHeadWithDeps({
      config,
      github,
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: reviewPull
    });

    expect(result.status).toBe("skipped_stale_head");
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "failed",
      error: "original timeout; retry_did_not_review=skipped_stale_head"
    });
    state.close();
  });

  it("treats a retry row posted after prepare as an already-resolved no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-race-posted-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1233, "head-retry-race");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });
    const github = {
      getPull: async () => pull,
      listIssueComments: async () => [],
      listPullFiles: async () => {
        throw new Error("already-resolved retry should not fetch files");
      },
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    const result = await retryFailedHeadWithDeps({
      config,
      github,
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: async (input) => {
        state.recordProcessed({
          repo: "electricsheephq/WorldOS",
          pullNumber: pull.number,
          headSha: pull.head.sha,
          status: "posted",
          event: "COMMENT",
          reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1233#pullrequestreview-1"
        });
        return reviewPull(input);
      }
    });

    expect(result.status).toBe("skipped_processed");
    expect(isSuccessfulRetryStatus(result.status)).toBe(true);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "posted",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1233#pullrequestreview-1"
    });
    state.close();
  });

  it("keeps dry-run processed retry rows queued instead of marking them posted", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-race-dry-run-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1234, "head-retry-dry-run");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });
    const queueJob = state.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha
    }).job;
    state.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "running",
      clearLease: false,
      lastError: "retry_started"
    });

    const result = await retryFailedHeadWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: async (input) => {
        state.recordProcessed({
          repo: "electricsheephq/WorldOS",
          pullNumber: pull.number,
          headSha: pull.head.sha,
          status: "dry_run",
          event: "COMMENT"
        });
        return reviewPull(input);
      }
    });

    expect(result.status).toBe("skipped_processed");
    const updatedQueueJob = state.getReviewQueueJob(queueJob.jobId);
    expect(updatedQueueJob).toMatchObject({
      state: "queued",
      lastError: "retry_did_not_review=skipped_processed:dry_run"
    });
    expect(updatedQueueJob?.reviewUrl).toBeUndefined();
    state.close();
  });

  it("settles retry-owned RepoSticky session rows for command-recorded outcomes", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-command-session-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1235, "head-retry-command");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original timeout"
    });
    const assignment = state.assignReviewerSessionJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      ttlMs: 60_000,
      headCountLimit: 5,
      allowProcessed: true
    });
    if (!assignment.session) throw new Error("expected session assignment");
    const queueJob = state.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      source: "manual_command",
      lane: "manual",
      commentId: 12345,
      sessionId: assignment.session.sessionId
    }).job;
    state.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "running",
      sessionId: assignment.session.sessionId,
      clearLease: false,
      lastError: "retry_started"
    });

    const result = await retryFailedHeadWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: async () => "skipped_command_explain"
    });

    expect(result.status).toBe("skipped_command_explain");
    expect(state.getReviewQueueJob(queueJob.jobId)).toMatchObject({
      state: "command_recorded",
      lastError: "manual_command_explain_recorded"
    });
    expect(state.getReviewerSessionJob("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      jobState: "skipped",
      processedReviewStatus: "skipped"
    });
    state.close();
  });

  it("does not retire automatic retry work when a provider retry only records a command", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-retry-command-auto-isolation-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1236, "head-retry-command-isolated");
    state.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      status: "failed",
      error: "original provider cooldown"
    });
    const automaticJob = state.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha
    }).job;
    state.updateReviewQueueJobState({
      jobId: automaticJob.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-01T00:01:00.000Z",
      lastError: "provider cooldown"
    });
    const manualJob = state.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: pull.number,
      headSha: pull.head.sha,
      baseSha: pull.base.sha,
      source: "manual_command",
      lane: "manual",
      commentId: 98765
    }).job;
    state.updateReviewQueueJobState({
      jobId: manualJob.jobId,
      state: "running",
      clearLease: false,
      lastError: "manual_retry_started"
    });

    const result = await retryFailedHeadWithDeps({
      config,
      github: retryGithub(pull),
      state,
      budget: new ReviewRunBudget(1),
      options: {
        repo: "electricsheephq/WorldOS",
        pullNumber: pull.number,
        headSha: pull.head.sha,
        dryRun: false,
        useZCode: false
      },
      reviewPullImpl: async () => "skipped_command_explain"
    });

    expect(result.status).toBe("skipped_command_explain");
    expect(state.getReviewQueueJob(manualJob.jobId)).toMatchObject({
      state: "command_recorded",
      lastError: "manual_command_explain_recorded"
    });
    expect(state.getReviewQueueJob(automaticJob.jobId)).toMatchObject({
      state: "provider_deferred",
      lastError: "provider cooldown"
    });
    state.close();
  });

  it("keeps retry CLI success status mapping explicit", () => {
    expect(isSuccessfulRetryStatus("reviewed")).toBe(true);
    expect(isSuccessfulRetryStatus("reviewed_command")).toBe(true);
    expect(isSuccessfulRetryStatus("dry_run")).toBe(true);
    expect(isSuccessfulRetryStatus("skipped_processed")).toBe(true);
    expect(isSuccessfulRetryStatus("skipped_closed")).toBe(true);
    expect(isSuccessfulRetryStatus("failed")).toBe(false);
    expect(isSuccessfulRetryStatus("skipped_capacity")).toBe(false);
    expect(isSuccessfulRetryStatus("skipped_provider_cooldown")).toBe(false);
    expect(isSuccessfulRetryStatus("skipped_stale_head")).toBe(false);
  });
});

function minimalConfig(root: string): BotConfig {
  return {
    pilotRepos: ["electricsheephq/WorldOS"],
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    activation: {
      reviewExistingOpenPrsOnActivation: false
    },
    reviewConcurrency: {
      maxActiveRuns: 1,
      leaseTtlMs: 60_000
    },
    providerCooldown: {
      enabled: true,
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 90_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      transientRetryAttempts: 4,
      transientRetryBaseDelayMs: 1,
      transientRetryMaxDelayMs: 1
    },
    walkthrough: {
      enabled: false,
      postIssueComment: false
    },
    commands: {
      enabled: false,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: [],
      acknowledge: false
    },
    zcode: {
      cliPath: "/unused/zcode.cjs",
      appConfigPath: "/unused/config.json",
      model: "GLM-5.2",
      timeoutMs: 1,
      maxPatchBytes: 1,
      retryMaxRetries: 0
    },
    github: {}
  };
}

function pullSummary(
  number: number,
  headSha: string,
  baseSha = "base",
  options: { state?: string; mergedAt?: string | null; body?: string | null; createdAt?: string } = {}
): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    ...(options.body !== undefined ? { body: options.body } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.createdAt ? { created_at: options.createdAt } : {}),
    ...(options.mergedAt !== undefined ? { merged_at: options.mergedAt } : {}),
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    base: {
      sha: baseSha,
      ref: "main",
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    html_url: `https://github.com/electricsheephq/WorldOS/pull/${number}`
  };
}

function githubRelatedReader(items: Record<string, {
  number: number;
  title?: string | null;
  state?: string | null;
  html_url?: string | null;
  pull_request?: unknown;
  body?: string | null;
  labels?: Array<{ name?: string | null } | string>;
}>) {
  return {
    async getIssueOrPull(repo: string, number: number) {
      return items[`${repo}#${number}`];
    }
  };
}

function workerGitNexusList(records: Array<{ alias: string; commit: string }>): string {
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
    return { ok: true, stdout: outputs[args[1] ?? ""] ?? "" };
  };
}

function failOnGitNexusQueryRunner(): GitNexusCommandRunner {
  return (args) => {
    if (args[0] === "query") throw new Error("GitNexus query should not run in degraded mode");
    return { ok: true, stdout: "" };
  };
}

function retryGithub(pull: PullRequestSummary): GitHubApi {
  return {
    getPull: async () => pull
  } as unknown as GitHubApi;
}
