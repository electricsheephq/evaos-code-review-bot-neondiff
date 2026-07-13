import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runZCodeReview } from "../src/zcode.js";

describe("asynchronous ZCode execution", () => {
  const roots: string[] = [];

  afterEach(() => {
    delete process.env.NEONDIFF_TEST_BARRIER_DIR;
    delete process.env.NEONDIFF_TEST_STARTED_PATH;
    delete process.env.NEONDIFF_TEST_TERMINATED_PATH;
    delete process.env.NEONDIFF_TEST_ATTEMPTS_PATH;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("starts three provider processes concurrently without blocking the event loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-zcode-async-"));
    roots.push(root);
    const barrierDir = join(root, "barrier");
    mkdirSync(barrierDir);
    process.env.NEONDIFF_TEST_BARRIER_DIR = barrierDir;
    const cliPath = join(root, "fake-zcode-cli.mjs");
    const appConfigPath = join(root, "zcode-config.json");
    writeFileSync(appConfigPath, JSON.stringify({
      provider: {
        "test:provider": {
          enabled: true,
          options: { apiKey: "test-secret", baseURL: "https://provider.invalid" },
          models: { "test-model": {} }
        }
      }
    }));
    writeFileSync(cliPath, `
      import { readdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const barrier = process.env.NEONDIFF_TEST_BARRIER_DIR;
      writeFileSync(join(barrier, String(process.pid)), "entered");
      const timer = setInterval(() => {
        if (readdirSync(barrier).length < 3) return;
        clearInterval(timer);
        process.stdout.write(JSON.stringify({ response: JSON.stringify({ findings: [], summary: "ok" }) }));
      }, 5);
    `);

    const worktrees = [0, 1, 2].map((index) => {
      const cwd = join(root, `worktree-${index}`);
      mkdirSync(cwd);
      return cwd;
    });
    let timerFired = false;
    const eventLoopTimer = setTimeout(() => { timerFired = true; }, 25);

    const results = await Promise.all(worktrees.map((cwd) => runZCodeReview({
      cwd,
      prompt: "review",
      cliPath,
      appConfigPath,
      model: "test-model",
      providerId: "test:provider",
      timeoutMs: 1_000
    })));
    clearTimeout(eventLoopTimer);

    expect(results).toHaveLength(3);
    expect(timerFired).toBe(true);
    for (const cwd of worktrees) expect(existsSync(join(cwd, ".zcode", "config.json"))).toBe(false);
  });

  it("terminates a timed-out child and restores the temporary policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-zcode-timeout-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    mkdirSync(cwd);
    const cliPath = join(root, "timeout-cli.mjs");
    const startedPath = join(root, "started");
    const terminatedPath = join(root, "terminated");
    process.env.NEONDIFF_TEST_STARTED_PATH = startedPath;
    process.env.NEONDIFF_TEST_TERMINATED_PATH = terminatedPath;
    writeFileSync(cliPath, `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.NEONDIFF_TEST_STARTED_PATH, String(process.pid));
      process.on("SIGTERM", () => {
        writeFileSync(process.env.NEONDIFF_TEST_TERMINATED_PATH, "terminated");
        process.exit(0);
      });
      setInterval(() => {}, 1000);
    `);
    const appConfigPath = writeProviderConfig(root);

    let thrown: unknown;
    try {
      await runZCodeReview({
        cwd,
        prompt: "review",
        cliPath,
        appConfigPath,
        model: "test-model",
        providerId: "test:provider",
        timeoutMs: 50
      });
    } catch (error) {
      thrown = error;
    }

    expect(existsSync(startedPath)).toBe(true);
    expect(existsSync(terminatedPath)).toBe(true);
    expect((thrown as Error & { code?: string }).code).toBe("ETIMEDOUT");
    expect((thrown as Error).message).toContain("ZCode failed before completion");
    expect(existsSync(join(cwd, ".zcode", "config.json"))).toBe(false);
  });

  it("escalates a timeout to SIGKILL and leaves no orphan when SIGTERM is ignored", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-zcode-sigkill-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    mkdirSync(cwd);
    const cliPath = join(root, "ignore-term-cli.mjs");
    const startedPath = join(root, "started");
    process.env.NEONDIFF_TEST_STARTED_PATH = startedPath;
    writeFileSync(cliPath, `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.NEONDIFF_TEST_STARTED_PATH, String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `);

    await expect(runZCodeReview({
      cwd,
      prompt: "review",
      cliPath,
      appConfigPath: writeProviderConfig(root),
      model: "test-model",
      providerId: "test:provider",
      timeoutMs: 50
    })).rejects.toMatchObject({ code: "ETIMEDOUT", signal: "SIGKILL" });

    const childPid = Number(readFileSync(startedPath, "utf8"));
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(existsSync(join(cwd, ".zcode", "config.json"))).toBe(false);
  });

  it("preserves strict-JSON retry provenance through the async transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-zcode-retry-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    mkdirSync(cwd);
    const cliPath = join(root, "retry-cli.mjs");
    const attemptsPath = join(root, "attempts");
    process.env.NEONDIFF_TEST_ATTEMPTS_PATH = attemptsPath;
    writeFileSync(cliPath, `
      import { appendFileSync } from "node:fs";
      const promptIndex = process.argv.indexOf("--prompt");
      const prompt = process.argv[promptIndex + 1] ?? "";
      appendFileSync(process.env.NEONDIFF_TEST_ATTEMPTS_PATH, "attempt\\n");
      const response = prompt.includes("previous review output was rejected")
        ? JSON.stringify({ findings: [], summary: "recovered" })
        : "not-json";
      process.stdout.write(JSON.stringify({ response }));
    `);

    const result = await runZCodeReview({
      cwd,
      prompt: "review",
      cliPath,
      appConfigPath: writeProviderConfig(root),
      model: "test-model",
      providerId: "test:provider",
      timeoutMs: 1_000
    });

    expect(result.attempts).toBe(2);
    expect(result.degradedRecovery).toBe(true);
    expect(readFileSync(attemptsPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("redacts provider secrets from nonzero-exit evidence and errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-zcode-redaction-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    const evidenceDir = join(root, "evidence");
    mkdirSync(cwd);
    const cliPath = join(root, "failure-cli.mjs");
    writeFileSync(cliPath, `
      process.stderr.write("provider failed with test-secret");
      process.exit(7);
    `);

    await expect(runZCodeReview({
      cwd,
      prompt: "review",
      cliPath,
      appConfigPath: writeProviderConfig(root),
      model: "test-model",
      providerId: "test:provider",
      evidenceDir,
      timeoutMs: 1_000
    })).rejects.not.toThrow("test-secret");

    expect(readFileSync(join(evidenceDir, "zcode-last-stderr.txt"), "utf8")).not.toContain("test-secret");
    expect(readFileSync(join(evidenceDir, "zcode-last-stderr.txt"), "utf8")).toContain("[redacted-secret]");
  });

  it("terminates output that exceeds the existing 20 MiB transport bound", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-zcode-output-bound-"));
    roots.push(root);
    const cwd = join(root, "worktree");
    mkdirSync(cwd);
    const cliPath = join(root, "large-output-cli.mjs");
    writeFileSync(cliPath, `process.stdout.write("x".repeat(21 * 1024 * 1024));`);

    let thrown: unknown;
    try {
      await runZCodeReview({
        cwd,
        prompt: "review",
        cliPath,
        appConfigPath: writeProviderConfig(root),
        model: "test-model",
        providerId: "test:provider",
        timeoutMs: 2_000
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error & { code?: string }).code).toBe("ENOBUFS");
    expect(existsSync(join(cwd, ".zcode", "config.json"))).toBe(false);
  });
});

function writeProviderConfig(root: string): string {
  const appConfigPath = join(root, "zcode-config.json");
  writeFileSync(appConfigPath, JSON.stringify({
    provider: {
      "test:provider": {
        enabled: true,
        options: { apiKey: "test-secret", baseURL: "https://provider.invalid" },
        models: { "test-model": {} }
      }
    }
  }));
  return appConfigPath;
}
