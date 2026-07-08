import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONTEXT_BUDGET_CONFIG,
  estimateContextTokens,
  planContextBudget
} from "../src/context-budget.js";
import type { PullFilePatch } from "../src/types.js";

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
