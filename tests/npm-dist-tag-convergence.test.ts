import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function extractConfirmationBlock(workflow = readFileSync(".github/workflows/publish-npm.yml", "utf8")): string {
  const begin = /^([ \t]*)# BEGIN POST_PROMOTION_CONFIRMATION$/m.exec(workflow);
  if (!begin || begin.index === undefined) throw new Error("post-promotion confirmation block start marker is missing");
  const indent = begin[1];
  const contentStart = begin.index + begin[0].length + 1;
  const endMarker = `${indent}# END POST_PROMOTION_CONFIRMATION`;
  const contentEnd = workflow.indexOf(endMarker, contentStart);
  if (contentEnd < 0) throw new Error("post-promotion confirmation block end marker is missing");
  const block = workflow.slice(contentStart, contentEnd)
    .split("\n")
    .map((line) => {
      if (line && !line.startsWith(indent)) throw new Error("post-promotion confirmation indentation is inconsistent");
      return line.slice(indent.length);
    })
    .join("\n");
  if (!block.includes("tags[npmTag] === expectedVersion")) throw new Error("post-promotion validator is missing");
  return block;
}

function writeFakeNpm(root: string): string {
  const binDir = join(root, "bin");
  const npmPath = join(binDir, "npm");
  mkdirSync(binDir);
  writeFileSync(
    npmPath,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "dist-tag" && args[1] === "rm") {
  const previousRm = existsSync(process.env.FAKE_NPM_RM_COUNTER) ? Number(readFileSync(process.env.FAKE_NPM_RM_COUNTER, "utf8")) : 0;
  writeFileSync(process.env.FAKE_NPM_RM_COUNTER, String(previousRm + 1));
  writeFileSync(process.env.FAKE_NPM_RM_MARKER, "removed");
  process.exit(0);
}
const counterPath = process.env.FAKE_NPM_VIEW_COUNTER;
const previousView = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
const count = previousView + 1;
writeFileSync(counterPath, String(count));
if (process.env.FAKE_NPM_MODE === "hang") {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
}
const converged = process.env.FAKE_NPM_MODE === "converge" && count >= Number(process.env.FAKE_NPM_CONVERGE_AT);
const tags = { latest: converged || process.env.FAKE_NPM_MODE === "unexpected" ? "1.0.3" : "1.0.2" };
if (process.env.FAKE_NPM_MODE === "unexpected") {
  tags["release-candidate"] = "9.9.9";
} else if (process.env.FAKE_NPM_MODE === "converge") {
  if (!existsSync(process.env.FAKE_NPM_RM_MARKER)) {
    tags["release-candidate"] = "1.0.3";
  } else {
    const previousCleanup = existsSync(process.env.FAKE_NPM_CLEANUP_COUNTER) ? Number(readFileSync(process.env.FAKE_NPM_CLEANUP_COUNTER, "utf8")) : 0;
    const cleanupCount = previousCleanup + 1;
    writeFileSync(process.env.FAKE_NPM_CLEANUP_COUNTER, String(cleanupCount));
    if (cleanupCount < Number(process.env.FAKE_NPM_CLEANUP_CONVERGE_AT)) tags["release-candidate"] = "1.0.3";
  }
}
process.stdout.write(JSON.stringify(tags));
`
  );
  chmodSync(npmPath, 0o755);
  return binDir;
}

function runWorkflowBlock(root: string, mode: "converge" | "stale" | "hang" | "unexpected", attempts: number, convergeAt = attempts) {
  const binDir = writeFakeNpm(root);
  const counterPath = join(root, "view-counter.txt");
  const cleanupCounterPath = join(root, "cleanup-counter.txt");
  const rmCounterPath = join(root, "rm-counter.txt");
  const rmMarkerPath = join(root, "rm-marker.txt");
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
      FAKE_NPM_VIEW_COUNTER: counterPath,
      FAKE_NPM_CLEANUP_COUNTER: cleanupCounterPath,
      FAKE_NPM_CLEANUP_CONVERGE_AT: "2",
      FAKE_NPM_RM_COUNTER: rmCounterPath,
      FAKE_NPM_RM_MARKER: rmMarkerPath,
      FAKE_NPM_MODE: mode,
      FAKE_NPM_CONVERGE_AT: String(convergeAt)
    }
  });
  return { cleanupCounterPath, counterPath, outputPath, result, rmCounterPath };
}

describe("npm dist-tag convergence confirmation", () => {
  it("retries stale registry reads until the promoted tag converges", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-dist-tag-converges-"));
    const { cleanupCounterPath, counterPath, outputPath, result, rmCounterPath } = runWorkflowBlock(root, "converge", 4, 3);

    expect(result.status).toBe(0);
    expect(Number(readFileSync(counterPath, "utf8"))).toBeGreaterThan(3);
    expect(readFileSync(cleanupCounterPath, "utf8")).toBe("2");
    expect(Number(readFileSync(rmCounterPath, "utf8"))).toBeGreaterThanOrEqual(1);
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

  it("fails closed without removing a quarantine tag owned by another version", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-dist-tag-unexpected-"));
    const { outputPath, result, rmCounterPath } = runWorkflowBlock(root, "unexpected", 2);

    expect(result.status).toBe(1);
    expect(existsSync(outputPath)).toBe(false);
    expect(existsSync(rmCounterPath)).toBe(false);
    expect(result.stderr).toContain("refusing to remove unexpected release-candidate version 9.9.9");
  });

  it("derives the workflow block indentation from its marker", () => {
    const shifted = `jobs:\n    # BEGIN POST_PROMOTION_CONFIRMATION\n    tags[npmTag] === expectedVersion\n    # END POST_PROMOTION_CONFIRMATION`;
    expect(extractConfirmationBlock(shifted)).toBe("tags[npmTag] === expectedVersion\n");
  });
});
