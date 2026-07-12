import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

describe("Review Bench public corpus gate", () => {
  it("makes live source admission and committed-receipt comparison mandatory in the publication workflow", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("node dist/src/cli.js review-bench verify-sources");
    expect(workflow).toContain("scripts/check-review-bench-admission-receipt.mjs");
    expect(workflow).toContain("--committed docs/bench/review-bench-corpus-v1/admission-receipt.json");
    expect(workflow).not.toMatch(/\n\s+paths:/);
    expect(workflow).not.toContain("continue-on-error");
  });

  it("accepts matching live/committed receipt claims and rejects hash drift", () => {
    const root = mkdtempSync(join(tmpdir(), "review-bench-receipt-gate-"));
    try {
      const livePath = join(root, "live.json");
      const committedPath = join(root, "committed.json");
      const live = receipt({ admittedAt: "2026-07-12T00:00:00.000Z" });
      const committed = receipt({ admittedAt: "2026-07-12T00:05:00.000Z" });
      writeFileSync(livePath, JSON.stringify(live));
      writeFileSync(committedPath, JSON.stringify(committed));

      const accepted = runReceiptGate(livePath, committedPath);
      expect(accepted.status).toBe(0);
      expect(JSON.parse(accepted.stdout)).toEqual(expect.objectContaining({
        ok: true,
        corpusHash: "a".repeat(64),
        verificationEvidenceSha256: "b".repeat(64)
      }));

      const drifted = receipt({
        admittedAt: "2026-07-12T00:05:00.000Z",
        verificationEvidenceSha256: "c".repeat(64)
      });
      writeFileSync(committedPath, JSON.stringify(drifted));
      const rejected = runReceiptGate(livePath, committedPath);
      expect(rejected.status).not.toBe(0);
      expect(`${rejected.stdout}\n${rejected.stderr}`).toContain("receipt mismatch for verificationEvidenceSha256");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("documents portable outside-checkout receipt generation and the reviewed publication handoff", () => {
    const operatorDocs = readFileSync(join(repoRoot, "docs/operator-cli.md"), "utf8");
    expect(operatorDocs).toContain("--receipt <outside-checkout-evidence-dir>/admission-receipt.json");
    expect(operatorDocs).toMatch(/copy that exact no-clobber\s+receipt into the publication worktree/);
    expect(operatorDocs).not.toContain("/Volumes/LEXAR/Codex/evals");
  });

  it("exposes the packaged review-bench command and flags through CLI help", () => {
    const result = spawnSync("npx", ["tsx", "src/cli.ts", "review-bench", "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });
    expect(result.status).toBe(0);
    const help = JSON.parse(result.stdout);
    expect(help.commands.existing).toContain("review-bench verify-sources");
    expect(help.usage.flags.map((flag: { name: string }) => flag.name)).toEqual([
      "--corpus",
      "--artifacts",
      "--receipt"
    ]);
  });
});

function receipt(overrides: Partial<{
  admittedAt: string;
  verificationEvidenceSha256: string;
}> = {}) {
  const basis = {
    schemaVersion: "review-bench-source-admission-receipt/v1",
    corpusVersion: "1.0.0",
    corpusHash: "a".repeat(64),
    verificationEvidenceSha256: overrides.verificationEvidenceSha256 ?? "b".repeat(64),
    scenarioCount: 150,
    sourceVerifierVersion: "github-public-source-ingest/v1",
    admittedAt: overrides.admittedAt ?? "2026-07-12T00:00:00.000Z"
  };
  return {
    ...basis,
    receiptSha256: createHash("sha256").update(stableJson(basis)).digest("hex")
  };
}

function runReceiptGate(livePath: string, committedPath: string) {
  return spawnSync("node", [
    "scripts/check-review-bench-admission-receipt.mjs",
    "--live",
    livePath,
    "--committed",
    committedPath
  ], { cwd: repoRoot, encoding: "utf8" });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
