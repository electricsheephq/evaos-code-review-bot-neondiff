import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveEvalOutputRoot } from "../src/eval-harness.js";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tsxCommand = process.env.NEONDIFF_TEST_TSX ?? join(repoRoot, "node_modules", ".bin", "tsx");

describe("portable output roots", () => {
  const roots: string[] = [];
  const originalEvalRoot = process.env.NEONDIFF_EVAL_ROOT;

  afterEach(() => {
    if (originalEvalRoot === undefined) delete process.env.NEONDIFF_EVAL_ROOT;
    else process.env.NEONDIFF_EVAL_ROOT = originalEvalRoot;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses a portable eval default and accepts an external explicit root", () => {
    delete process.env.NEONDIFF_EVAL_ROOT;
    expect(resolveEvalOutputRoot()).toBe(join(homedir(), ".local", "share", "neondiff", "evals"));

    const externalRoot = mkdtempSync(join(tmpdir(), "neondiff-eval-root-"));
    roots.push(externalRoot);
    process.env.NEONDIFF_EVAL_ROOT = externalRoot;
    expect(resolveEvalOutputRoot()).toBe(externalRoot);
  });

  it("rejects checkout children, dot-dot siblings, and symlink aliases for eval output", () => {
    for (const root of [repoRoot, join(repoRoot, "..eval")]) {
      process.env.NEONDIFF_EVAL_ROOT = root;
      expect(() => resolveEvalOutputRoot()).toThrow(/must not be inside the current git checkout/);
    }

    const aliasRoot = mkdtempSync(join(tmpdir(), "neondiff-eval-alias-"));
    roots.push(aliasRoot);
    const alias = join(aliasRoot, "checkout");
    symlinkSync(repoRoot, alias, "dir");
    process.env.NEONDIFF_EVAL_ROOT = alias;
    expect(() => resolveEvalOutputRoot()).toThrow(/must not be inside the current git checkout/);
  });

  it("rejects hostile QA roots before creating evidence", () => {
    const hostileRoot = mkdtempSync(join(repoRoot, ".portable-qa-hostile-"));
    roots.push(hostileRoot);
    const result = spawnSync(tsxCommand, [join(repoRoot, "scripts/qa-lab/queue-sim.ts")], {
      cwd: join(repoRoot, "tests"),
      env: { ...process.env, NEONDIFF_EVIDENCE_ROOT: hostileRoot },
      encoding: "utf8",
      timeout: 10_000
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must be outside a protected checkout root");
    expect(existsSync(join(hostileRoot, "neondiff-qa-lab"))).toBe(false);

    const externalRoot = mkdtempSync(join(tmpdir(), "neondiff-qa-symlink-"));
    roots.push(externalRoot);
    symlinkSync(repoRoot, join(externalRoot, "neondiff-qa-lab"), "dir");
    const nestedAlias = spawnSync(tsxCommand, [join(repoRoot, "scripts/qa-lab/queue-sim.ts")], {
      cwd: join(repoRoot, "tests"),
      env: { ...process.env, NEONDIFF_EVIDENCE_ROOT: externalRoot },
      encoding: "utf8",
      timeout: 10_000
    });
    expect(nestedAlias.status).toBe(1);
    expect(nestedAlias.stdout).toBe("");
    expect(nestedAlias.stderr).toContain("must be outside a protected checkout root");
    expect(existsSync(join(repoRoot, "risk-queue"))).toBe(false);
  });

  it("accepts an external QA root", () => {
    const externalRoot = mkdtempSync(join(tmpdir(), "neondiff-qa-root-"));
    roots.push(externalRoot);
    const result = spawnSync(tsxCommand, [join(repoRoot, "scripts/qa-lab/queue-sim.ts")], {
      cwd: join(repoRoot, "tests"),
      env: { ...process.env, NEONDIFF_EVIDENCE_ROOT: externalRoot },
      encoding: "utf8",
      timeout: 30_000
    });
    const output = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.evidenceDir).toBe(join(externalRoot, "neondiff-qa-lab", "risk-queue"));
  });
});
