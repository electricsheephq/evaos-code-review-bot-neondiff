import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function extractConfirmationBlock(): string {
  const workflow = readFileSync(".github/workflows/publish-npm.yml", "utf8");
  const match = workflow.match(/# BEGIN POST_PROMOTION_CONFIRMATION\n([\s\S]*?)          # END POST_PROMOTION_CONFIRMATION/);
  if (!match) throw new Error("post-promotion confirmation block markers are missing");
  return match[1]
    .split("\n")
    .map((line) => line.replace(/^ {10}/, ""))
    .join("\n");
}

function writeFakeNpm(root: string): string {
  const binDir = join(root, "bin");
  const npmPath = join(binDir, "npm");
  mkdirSync(binDir);
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const counterPath = process.env.FAKE_NPM_COUNTER;
const previous = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
const count = previous + 1;
writeFileSync(counterPath, String(count));
if (process.env.FAKE_NPM_MODE === "hang") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
const converged = process.env.FAKE_NPM_MODE === "converge" && count >= Number(process.env.FAKE_NPM_CONVERGE_AT);
process.stdout.write(JSON.stringify({ latest: converged ? "1.0.3" : "1.0.2" }));
`
  );
  chmodSync(npmPath, 0o755);
  return binDir;
}

function runWorkflowBlock(root: string, mode: "converge" | "stale" | "hang", attempts: number, convergeAt = attempts) {
  const binDir = writeFakeNpm(root);
  const counterPath = join(root, "counter.txt");
  const outputPath = join(root, "confirmed.json");
  const scriptPath = join(root, "confirm.sh");
  writeFileSync(scriptPath, `#!/bin/sh\nset -eu\n${extractConfirmationBlock()}\n`);
  chmodSync(scriptPath, 0o755);
  const result = spawnSync("/bin/sh", [scriptPath], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PACKAGE_VERSION: "1.0.3",
      NPM_TAG: "latest",
      NPM_CONFIRM_ATTEMPTS: String(attempts),
      NPM_CONFIRM_DELAY_MS: "1",
      NPM_CONFIRM_TIMEOUT_MS: "500",
      NPM_CONFIRM_OUTPUT: outputPath,
      FAKE_NPM_COUNTER: counterPath,
      FAKE_NPM_MODE: mode,
      FAKE_NPM_CONVERGE_AT: String(convergeAt)
    }
  });
  return { counterPath, outputPath, result };
}

describe("npm dist-tag convergence confirmation", () => {
  it("retries stale registry reads until the promoted tag converges", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-dist-tag-converges-"));
    const { counterPath, outputPath, result } = runWorkflowBlock(root, "converge", 4, 3);

    expect(result.status).toBe(0);
    expect(readFileSync(counterPath, "utf8")).toBe("3");
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({ latest: "1.0.3" });
  });

  it("fails closed after the bounded attempt count when the tag never converges", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-dist-tag-stale-"));
    const { counterPath, outputPath, result } = runWorkflowBlock(root, "stale", 3);

    expect(result.status).toBe(1);
    expect(readFileSync(counterPath, "utf8")).toBe("3");
    expect(existsSync(outputPath)).toBe(false);
    expect(result.stderr).toContain("npm dist-tag did not converge to the promoted package after 3 attempts");
  });

  it("times out each hung npm read while preserving the overall attempt bound", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-dist-tag-hangs-"));
    const { counterPath, outputPath, result } = runWorkflowBlock(root, "hang", 2);

    expect(result.status).toBe(1);
    expect(readFileSync(counterPath, "utf8")).toBe("2");
    expect(existsSync(outputPath)).toBe(false);
    expect(result.stderr).toContain("npm dist-tag did not converge to the promoted package after 2 attempts");
  });
});
