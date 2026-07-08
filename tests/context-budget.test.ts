import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  estimateContextTokens,
  planContextBudget
} from "../src/context-budget.js";
import { loadConfigFromObject } from "../src/config.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";
import { buildReviewPrompt } from "../src/zcode.js";

describe("context budget preflight", () => {
  it("estimates prompt tokens with a provider fudge factor", () => {
    expect(estimateContextTokens("x".repeat(100), { charsPerToken: 4, providerFudgeFactor: 1.2 })).toBe(30);
  });

  it("skips before provider execution when the full prompt is over budget and overflow=skip", () => {
    const plan = planContextBudget({
      prompt: "x".repeat(9_000),
      files: [file("src/large.ts", 100)],
      contextWindowTokens: 2_000,
      config: {
        ...DEFAULT_CONTEXT_BUDGET_CONFIG,
        overflow: "skip",
        reservedOutputTokens: 500,
        charsPerToken: 4,
        providerFudgeFactor: 1
      },
      buildPrompt: (files) => files.map((entry) => `${entry.filename}\n${entry.patch ?? ""}`).join("\n")
    });

    expect(plan).toMatchObject({
      mode: "skip",
      estimatedTokens: 2250,
      budgetTokens: 1500,
      reason: "context_budget_overflow"
    });
    expect(plan.chunks).toBeUndefined();
  });

  it("chunks over-budget prompts deterministically by file boundary", () => {
    const files = [file("src/a.ts", 30), file("src/b.ts", 30), file("src/c.ts", 30)];
    const buildPrompt = (chunkFiles: PullFilePatch[]) =>
      `shared\n${chunkFiles.map((entry) => `${entry.filename}\n${entry.patch ?? ""}`).join("\n")}`;

    const plan = planContextBudget({
      prompt: buildPrompt(files),
      files,
      contextWindowTokens: 102,
      config: {
        ...DEFAULT_CONTEXT_BUDGET_CONFIG,
        overflow: "chunk",
        reservedOutputTokens: 15,
        charsPerToken: 1,
        providerFudgeFactor: 1
      },
      buildPrompt
    });

    expect(plan.mode).toBe("chunk");
    expect(plan.chunks?.map((chunk) => chunk.files.map((entry) => entry.filename))).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/c.ts"]
    ]);
    expect(plan.chunks?.every((chunk) => chunk.estimatedTokens <= 87)).toBe(true);
  });

  it("fails closed when chunk mode cannot fit a single file within the budget", () => {
    const files = [file("src/huge.ts", 100)];
    const buildPrompt = (chunkFiles: PullFilePatch[]) =>
      `shared\n${chunkFiles.map((entry) => `${entry.filename}\n${entry.patch ?? ""}`).join("\n")}`;

    const plan = planContextBudget({
      prompt: buildPrompt(files),
      files,
      contextWindowTokens: 80,
      config: {
        ...DEFAULT_CONTEXT_BUDGET_CONFIG,
        overflow: "chunk",
        reservedOutputTokens: 20,
        charsPerToken: 1,
        providerFudgeFactor: 1
      },
      buildPrompt
    });

    expect(plan).toMatchObject({
      mode: "skip",
      reason: "context_budget_single_file_overflow"
    });
    expect(plan.chunks).toBeUndefined();
  });

  it("fails closed when an over-budget chunk plan has no changed files", () => {
    const files: PullFilePatch[] = [];
    const buildPrompt = (chunkFiles: PullFilePatch[]) => buildReviewPrompt({
      repo: "owner/repo",
      pull: pullSummary(),
      files: chunkFiles,
      repoMemoryPacket: advisoryPacket("repo-memory", 1_000)
    });

    const plan = planContextBudget({
      prompt: buildPrompt(files),
      files,
      contextWindowTokens: 600,
      config: {
        ...DEFAULT_CONTEXT_BUDGET_CONFIG,
        overflow: "chunk",
        reservedOutputTokens: 100,
        charsPerToken: 1,
        providerFudgeFactor: 1
      },
      buildPrompt
    });

    expect(plan).toMatchObject({
      mode: "skip",
      reason: "context_budget_overflow"
    });
    expect(plan.chunks).toBeUndefined();
  });

  it("keeps the default ZCode budget above the existing max patch prompt ceiling", () => {
    const config = loadConfigFromObject({});
    const files = [file("src/max-patch.ts", config.zcode.maxPatchBytes)];
    const buildPrompt = (chunkFiles: PullFilePatch[]) => buildReviewPrompt({
      repo: "owner/repo",
      pull: pullSummary(),
      files: chunkFiles,
      maxPatchBytes: config.zcode.maxPatchBytes
    });
    const prompt = buildPrompt(files);

    const plan = planContextBudget({
      prompt,
      files,
      contextWindowTokens: config.providers!.providers[config.providers!.defaultProviderId]!.contextWindowTokens,
      config: config.contextBudget,
      buildPrompt
    });

    expect(plan).toMatchObject({
      mode: "within_budget",
      contextWindowTokens: 128_000,
      budgetTokens: 123_904,
      reason: "context_budget_within_budget"
    });
  });

  it("keeps the default ZCode budget above max patch plus configured advisory packet ceilings", () => {
    const config = loadConfigFromObject({});
    const files = [file("src/max-patch.ts", config.zcode.maxPatchBytes)];
    const buildPrompt = (chunkFiles: PullFilePatch[]) => buildReviewPrompt({
      repo: "owner/repo",
      pull: pullSummary(),
      files: chunkFiles,
      maxPatchBytes: config.zcode.maxPatchBytes,
      repoMemoryPacket: advisoryPacket("repo-memory", config.repoMemory!.maxPacketBytes),
      gitnexusContextPacket: {
        ...advisoryPacket("gitnexus", config.gitnexusContext!.maxPacketBytes),
        gitnexus: { freshness: "fresh", degradedMode: false }
      },
      githubRelatedContextPacket: advisoryPacket("github-related", config.githubRelatedContext!.maxPacketBytes),
      skillPackContextPacket: advisoryPacket("skill-pack", config.skillPacks!.maxPacketBytes)
    });
    const prompt = buildPrompt(files);

    const plan = planContextBudget({
      prompt,
      files,
      contextWindowTokens: config.providers!.providers[config.providers!.defaultProviderId]!.contextWindowTokens,
      config: config.contextBudget,
      buildPrompt
    });

    expect(plan).toMatchObject({
      mode: "within_budget",
      contextWindowTokens: 128_000,
      budgetTokens: 123_904,
      reason: "context_budget_within_budget"
    });
    if (plan.mode !== "within_budget") throw new Error(`expected within_budget plan, got ${plan.mode}`);
    expect(plan.estimatedTokens).toBeLessThanOrEqual(plan.budgetTokens);
  });

  it("uses literal reasons for non-skip plan outcomes", () => {
    const files = [file("src/a.ts", 10)];
    const buildPrompt = (chunkFiles: PullFilePatch[]) =>
      chunkFiles.map((entry) => `${entry.filename}\n${entry.patch ?? ""}`).join("\n");

    expect(planContextBudget({
      prompt: buildPrompt(files),
      files,
      contextWindowTokens: 100,
      config: {
        ...DEFAULT_CONTEXT_BUDGET_CONFIG,
        enabled: false
      },
      buildPrompt
    })).toMatchObject({
      mode: "disabled",
      reason: "context_budget_disabled"
    });

    expect(planContextBudget({
      prompt: buildPrompt(files),
      files,
      config: DEFAULT_CONTEXT_BUDGET_CONFIG,
      buildPrompt
    })).toMatchObject({
      mode: "unknown_window",
      reason: "context_window_tokens_not_configured"
    });
  });
});

function file(filename: string, patchLength: number): PullFilePatch {
  return {
    filename,
    patch: "x".repeat(patchLength),
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2
  };
}

function advisoryPacket(prefix: string, byteEstimate: number) {
  const marker = `# ${prefix}\n`;
  return {
    sha256: prefix.padEnd(64, "0").slice(0, 64),
    byteEstimate,
    tokenEstimate: Math.ceil(byteEstimate / 4),
    markdown: `${marker}${"x".repeat(Math.max(0, byteEstimate - marker.length))}`
  };
}

function pullSummary(): PullRequestSummary {
  return {
    number: 401,
    title: "Default context budget",
    draft: false,
    head: {
      sha: "h".repeat(40),
      ref: "feature"
    },
    base: {
      sha: "b".repeat(40),
      ref: "main",
      repo: {
        full_name: "owner/repo"
      }
    },
    html_url: "https://github.test/owner/repo/pull/401"
  };
}
