import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import type { CodexExecInvocation } from "../src/codex-runtime.js";
import { runConfiguredReview, runSevereCodexRawJson } from "../src/worker.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(["review", "severe verifier"] as const)("worker Codex tier: %s", (path) => {
  it.each([undefined, "default", "priority"] as const)("passes configured tier %s exactly once, or omits it when unset", async (serviceTier) => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-worker-tier-"));
    roots.push(root);
    const config = loadConfigFromObject({ codexRuntime: { enabled: true, checkoutReads: false, serviceTier } });
    const runProcess = vi.fn(async (invocation: CodexExecInvocation) => {
      const tierArgs = invocation.args.filter((arg) => arg.includes("service_tier"));
      expect(tierArgs).toEqual(serviceTier === undefined ? [] : [`service_tier="${serviceTier}"`]);
      if (serviceTier !== undefined) {
        const index = invocation.args.indexOf(tierArgs[0]!);
        expect(invocation.args.slice(index - 1, index + 1)).toEqual(["-c", `service_tier="${serviceTier}"`]);
      }
      const response = path === "review" ? { findings: [], summary: {
        changedBehavior: ["Fixture"], invariants: ["Fixture"], evidence: ["Fixture"],
        limitations: ["Synthetic output only"], noFindingRationale: "Fixture"
      } } : { fixture: "severe verifier raw JSON" };
      writeFileSync(invocation.outputPath, JSON.stringify(response));
      return { stdout: "", stderr: "", status: 0, signal: null };
    });
    const dependencies = { runProcess, captureWorktreeState: () => "unchanged" };
    if (path === "review") {
      const result = await runConfiguredReview({ config, worktreePath: root, prompt: "Synthetic fixture", evidenceDir: root }, dependencies);
      expect(result.findings).toEqual([]);
    } else {
      const result = await runSevereCodexRawJson(config, root, "Synthetic fixture", root, dependencies);
      expect(JSON.parse(result)).toEqual({ fixture: "severe verifier raw JSON" });
    }
    expect(runProcess).toHaveBeenCalledOnce();
  });
});
