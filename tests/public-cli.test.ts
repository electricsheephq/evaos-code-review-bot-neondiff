import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewStateStore } from "../src/state.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const repoRoot = process.cwd();

describe("public NeonDiff CLI surface", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("declares the neondiff source-checkout binary", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));

    expect(packageJson.bin).toMatchObject({
      neondiff: "dist/src/cli.js",
      "evaos-review-bot": "dist/src/cli.js"
    });
    expect(packageLock.packages[""].bin).toMatchObject({
      neondiff: "dist/src/cli.js",
      "evaos-review-bot": "dist/src/cli.js"
    });
  });

  it("shows public commands in help output", async () => {
    const { stdout } = await runCli(["help"]);
    const output = JSON.parse(stdout);

    expect(output.commands.public).toEqual([
      "init",
      "config inspect",
      "config patch",
      "doctor",
      "daemon start",
      "daemon stop",
      "daemon status",
      "license activate",
      "license status",
      "license deactivate",
      "status",
      "review-pr"
    ]);
    expect(output.examples).toContain("neondiff init --config config.local.json");
    expect(output.examples).toContain("neondiff license status --config config.local.json --json");
    expect(output.examples).toContain("npx tsx src/cli.ts daemon --config /path/to/live.json --dry-run true --once true");
    expect(output.commands.existing).toContain("provider-throttle-report");
    expect(output.examples).toContain(
      "npx tsx src/cli.ts provider-throttle-report --config /path/to/live.json --since 7d --timezone Asia/Singapore"
    );
    expect(output.examples).toContain(
      "npx tsx src/cli.ts review-head-gate --config /path/to/live.json --repo owner/repo --pr 123 --head-sha \"$(gh pr view 123 --repo owner/repo --json headRefOid --jq .headRefOid)\""
    );
    expect(output.examples).not.toContain(
      "npx tsx src/cli.ts review-head-gate --config /path/to/live.json --repo owner/repo --pr 123 --head-sha HEAD"
    );
    expect(output.examples).toContain("desktop-patch.json uses nested object shape, e.g. {\"zcode\":{\"cliPath\":\"/path/to/neondiff\"}}");
  });

  it("rejects non-boolean public rollback ref verification values", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-release-status-bool-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      pollIntervalMs: 60_000
    })}\n`);

    await expect(runCli([
      "release-status",
      "--config",
      configPath,
      "--verify-public-rollback-refs",
      "yes"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--verify-public-rollback-refs must be true or false")
    });
  });

  it("prints command help without executing run-once, review-pr, or daemon paths", async () => {
    for (const args of [["run-once", "--help"], ["review-pr", "help"], ["daemon", "start", "-h"]]) {
      const { stdout } = await runCli(args);
      const output = JSON.parse(stdout);

      expect(output.ok).toBe(true);
      expect(output.command).toBe(args[0]);
      expect(output.commands.existing).toContain("run-once");
      expect(output.commands.public).toContain("review-pr");
      expect(stdout).not.toContain("\"dryRun\"");
      expect(stdout).not.toContain("\"reposScanned\"");
    }
  });

  it("initializes a local config from the packaged example outside the repo cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-init-"));
    roots.push(root);
    const configPath = join(root, "config.local.json");

    const { stdout } = await runCli(["init", "--config", "config.local.json"], {
      cwd: root
    });
    const output = JSON.parse(stdout);
    const example = readFileSync(join(repoRoot, "config.example.json"), "utf8");

    expect(output).toMatchObject({
      ok: true,
      command: "init",
      created: true
    });
    expect(realpathSync(output.configPath)).toBe(realpathSync(configPath));
    expect(existsSync(configPath)).toBe(true);
    const config = readFileSync(configPath, "utf8");
    expect(config).toBe(example);
    expect(example).toContain("\"pilotRepos\"");
    expect(example).not.toMatch(/ghp_|BEGIN PRIVATE KEY|api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}/i);
  });

  it("refuses to overwrite an existing config without force", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-init-existing-"));
    roots.push(root);
    const configPath = join(root, "config.local.json");
    writeFileSync(configPath, "{}\n");

    await expect(runCli(["init", "--config", configPath])).rejects.toMatchObject({
      stdout: expect.stringContaining("config already exists")
    });
  });

  it("only force-overwrites existing JSON config-looking files", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-init-force-"));
    roots.push(root);
    const textPath = join(root, "notes.txt");
    const configPath = join(root, "config.local.json");
    writeFileSync(textPath, "do not replace me\n");
    writeFileSync(configPath, "{}\n");

    await expect(runCli(["init", "--config", textPath, "--force", "true"])).rejects.toMatchObject({
      stdout: expect.stringContaining("only overwrites existing JSON config files")
    });

    const { stdout } = await runCli(["init", "--config", configPath, "--force", "true"]);
    const output = JSON.parse(stdout);

    expect(output.ok).toBe(true);
    expect(output.backupPath).toEqual(expect.stringContaining("config.local.json."));
    expect(existsSync(output.backupPath)).toBe(true);
    expect(readFileSync(output.backupPath, "utf8")).toBe("{}\n");
  });

  it("does not mutate failed review rows when retire-failed runs in dry-run mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retire-failed-dry-run-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 176;
    const headSha = "dry-run-failed-head";
    const previousError = "ZCode failed before completion: spawnSync node ETIMEDOUT";
    let store = new ReviewStateStore(statePath);

    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "failed",
      error: previousError
    });
    const queueJob = store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base-head",
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: previousError,
      now: new Date("2026-07-03T00:01:00.000Z")
    });
    const beforeProcessed = store.getProcessedReview(repo, pullNumber, headSha);
    const beforeQueueJob = store.getReviewQueueJob(queueJob.jobId);
    store.close();

    const { stdout } = await runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha,
      "--reason",
      "Closed Or Merged Before Review!",
      "--dry-run",
      "true"
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      wouldRetire: {
        repo,
        pullNumber,
        headSha,
        status: "failed",
        error: previousError
      },
      reason: "closed_or_merged_before_review",
      retiredErrorPreview: `retired_failed_head:closed_or_merged_before_review; previous_error=${previousError}`
    });
    store = new ReviewStateStore(statePath);
    expect(store.getProcessedReview(repo, pullNumber, headSha)).toEqual(beforeProcessed);
    expect(store.getReviewQueueJob(queueJob.jobId)).toEqual(beforeQueueJob);
    store.close();
  });

  it("refuses retire-failed dry-runs for missing or non-failed rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retire-failed-refuse-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 176;
    const store = new ReviewStateStore(statePath);

    store.recordProcessed({
      repo,
      pullNumber,
      headSha: "posted-head",
      status: "posted",
      event: "COMMENT"
    });
    store.close();

    await expect(runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      "missing-head",
      "--reason",
      "operator_request",
      "--dry-run",
      "true"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining(`Refusing to retire missing review row for ${repo}#${pullNumber}@missing-head`)
    });

    await expect(runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      "posted-head",
      "--reason",
      "operator_request",
      "--dry-run",
      "true"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining(`Refusing to retire ${repo}#${pullNumber}@posted-head: status is posted, not failed`)
    });
  });

  it("redacts retire-failed dry-run output before operators copy evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retire-failed-redact-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 176;
    const headSha = "secret-failed-head";
    const ghToken = "ghp_abcdefghijklmnopqrstuvwx";
    const bearerToken = "Bearer abcdefghijklmnopqrstuvwxyz";
    let store = new ReviewStateStore(statePath);

    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "failed",
      error: `provider failed with ${ghToken} at https://user@example.com`
    });
    const queueJob = store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base-head",
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: `retry failed with ${bearerToken}`,
      now: new Date("2026-07-03T00:01:00.000Z")
    });
    store.close();

    const { stdout } = await runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha,
      "--reason",
      "closed_or_merged_before_review",
      "--dry-run",
      "true"
    ]);
    const output = JSON.parse(stdout);

    expect(stdout).not.toContain(ghToken);
    expect(stdout).not.toContain(bearerToken);
    expect(stdout).not.toContain("https://user@example.com");
    expect(output.wouldRetire.error).toContain("[redacted-secret]");
    expect(output.retiredErrorPreview).toContain("[redacted-secret]");
    expect(output.queueJobsToRetire[0].lastError).toContain("[redacted-secret]");
  });

  it("retires failed review rows only when retire-failed is explicit non-dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retire-failed-live-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 176;
    const headSha = "live-failed-head";
    const previousError = "ZCode failed before completion: spawnSync node ETIMEDOUT";
    let store = new ReviewStateStore(statePath);

    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "failed",
      error: previousError
    });
    const queueJob = store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base-head",
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: previousError,
      now: new Date("2026-07-03T00:01:00.000Z")
    });
    store.close();

    const { stdout } = await runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha,
      "--reason",
      "closed_or_merged_before_review",
      "--dry-run",
      "false"
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      dryRun: false,
      retired: {
        repo,
        pullNumber,
        headSha,
        status: "skipped",
        error: "retired_failed_head:closed_or_merged_before_review; previous_error=ZCode failed before completion: spawnSync node ETIMEDOUT"
      }
    });
    store = new ReviewStateStore(statePath);
    expect(store.getProcessedReview(repo, pullNumber, headSha)).toMatchObject({
      status: "skipped",
      error: "retired_failed_head:closed_or_merged_before_review; previous_error=ZCode failed before completion: spawnSync node ETIMEDOUT"
    });
    expect(store.getReviewQueueJob(queueJob.jobId)).toMatchObject({
      state: "stale_retired",
      lastError: "retired_failed_head:closed_or_merged_before_review; previous_error=ZCode failed before completion: spawnSync node ETIMEDOUT"
    });
    store.close();
  });

  it("previews failed queue reconciliation for already retired heads without mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retire-failed-already-dry-run-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 176;
    const headSha = "already-retired-head";
    const retiredError = "retired_failed_head:old_operator_run; previous_error=ENOENT";
    let store = new ReviewStateStore(statePath);

    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "skipped",
      error: retiredError
    });
    const queueJob = store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base-head",
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: "ENOENT",
      now: new Date("2026-07-03T00:01:00.000Z")
    });
    const beforeProcessed = store.getProcessedReview(repo, pullNumber, headSha);
    const beforeQueueJob = store.getReviewQueueJob(queueJob.jobId);
    store.close();

    const { stdout } = await runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha,
      "--reason",
      "closed_or_merged_before_review",
      "--dry-run",
      "true"
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      alreadyRetired: {
        repo,
        pullNumber,
        headSha,
        status: "skipped",
        error: retiredError
      },
      queueJobsToRetire: [
        {
          jobId: queueJob.jobId,
          repo,
          pullNumber,
          headSha,
          state: "failed",
          lastError: "ENOENT"
        }
      ]
    });
    store = new ReviewStateStore(statePath);
    expect(store.getProcessedReview(repo, pullNumber, headSha)).toEqual(beforeProcessed);
    expect(store.getReviewQueueJob(queueJob.jobId)).toEqual(beforeQueueJob);
    store.close();
  });

  it("reconciles failed queue jobs for already retired heads only when explicit non-dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-retire-failed-already-live-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 176;
    const headSha = "already-retired-live-head";
    const retiredError = "retired_failed_head:old_operator_run; previous_error=ENOENT";
    let store = new ReviewStateStore(statePath);

    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "skipped",
      error: retiredError
    });
    const queueJob = store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base-head",
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: "ENOENT",
      now: new Date("2026-07-03T00:01:00.000Z")
    });
    store.close();

    const { stdout } = await runCli([
      "retire-failed",
      "--state-path",
      statePath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha,
      "--reason",
      "closed_or_merged_before_review",
      "--dry-run",
      "false"
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      dryRun: false,
      retired: {
        repo,
        pullNumber,
        headSha,
        status: "skipped",
        error: retiredError
      }
    });
    store = new ReviewStateStore(statePath);
    expect(store.getProcessedReview(repo, pullNumber, headSha)).toMatchObject({
      status: "skipped",
      error: retiredError
    });
    expect(store.getReviewQueueJob(queueJob.jobId)).toMatchObject({
      state: "stale_retired",
      lastError: retiredError
    });
    store.close();
  });

  it("passes review-head-gate only for an exact head with a posted evaOS review", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-pass-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const headSha = "fb40fd1d340bb9896b2988b7913395df0b983c3d";
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "posted",
      event: "COMMENT",
      reviewUrl: `https://github.com/${repo}/pull/${pullNumber}#pullrequestreview-1`
    });
    store.close();

    const { stdout } = await runCli([
      "review-head-gate",
      "--config",
      configPath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      healthState: "review_head_gate_ok",
      decision: "passed",
      repo,
      pullNumber,
      headSha,
      processed: {
        status: "posted",
        event: "COMMENT"
      }
    });
  });

  it("fails review-head-gate for a final head the daemon never observed", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-missing-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const previousHead = "8fef8d6abd0924d42b1d37d11911aed2587619cc";
    const finalHead = "fb40fd1d340bb9896b2988b7913395df0b983c3d";
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    store.recordProcessed({
      repo,
      pullNumber,
      headSha: previousHead,
      status: "posted",
      event: "COMMENT"
    });
    store.close();

    try {
      await runCli([
        "review-head-gate",
        "--config",
        configPath,
        "--repo",
        repo,
        "--pr",
        String(pullNumber),
        "--head-sha",
        finalHead
      ]);
      throw new Error("review-head-gate unexpectedly passed");
    } catch (error) {
      const stdout = (error as { stdout: string }).stdout;
      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: false,
        healthState: "review_head_gate_blocked",
        decision: "missing",
        repo,
        pullNumber,
        headSha: finalHead,
        queueJobs: [],
        nextAction: expect.stringContaining("do not merge")
      });
      expect(output.gates[0]).toMatchObject({
        name: "exact_head_has_recorded_nonblocking_evaos_review",
        ok: false
      });
    }
  });

  it("fails review-head-gate for exact heads with evaOS requested changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-needs-fix-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "posted",
      event: "REQUEST_CHANGES",
      reviewUrl: `https://github.com/${repo}/pull/${pullNumber}#pullrequestreview-2`
    });
    store.close();

    try {
      await runCli([
        "review-head-gate",
        "--config",
        configPath,
        "--repo",
        repo,
        "--pr",
        String(pullNumber),
        "--head-sha",
        headSha
      ]);
      throw new Error("review-head-gate unexpectedly passed");
    } catch (error) {
      const output = JSON.parse((error as { stdout: string }).stdout);
      expect(output).toMatchObject({
        ok: false,
        decision: "needs_fix",
        processed: {
          status: "posted",
          event: "REQUEST_CHANGES"
        },
        nextAction: expect.stringContaining("do not merge")
      });
    }
  });

  it("blocks review-head-gate when an exact-head re-review job is still active", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-rereview-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const headSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "posted",
      event: "COMMENT",
      reviewUrl: `https://github.com/${repo}/pull/${pullNumber}#pullrequestreview-3`
    });
    store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base",
      source: "manual_command",
      priority: 0,
      now: new Date("2099-01-01T00:00:00.000Z")
    });
    store.close();

    try {
      await runCli([
        "review-head-gate",
        "--config",
        configPath,
        "--repo",
        repo,
        "--pr",
        String(pullNumber),
        "--head-sha",
        headSha
      ]);
      throw new Error("review-head-gate unexpectedly passed");
    } catch (error) {
      const output = JSON.parse((error as { stdout: string }).stdout);
      expect(output).toMatchObject({
        ok: false,
        decision: "queued",
        processed: {
          status: "posted",
          event: "COMMENT"
        },
        nextAction: expect.stringContaining("wait for evaOS review")
      });
    }
  });

  it("does not let older active queue residue block a newer posted exact-head review", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-zombie-active-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const headSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base",
      source: "manual_command",
      priority: 0,
      now: new Date("2020-01-01T00:00:00.000Z")
    });
    store.recordProcessed({
      repo,
      pullNumber,
      headSha,
      status: "posted",
      event: "COMMENT",
      reviewUrl: `https://github.com/${repo}/pull/${pullNumber}#pullrequestreview-5`
    });
    store.close();

    const { stdout } = await runCli([
      "review-head-gate",
      "--config",
      configPath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      decision: "passed",
      processed: {
        status: "posted",
        event: "COMMENT"
      },
      queueJobs: [
        {
          state: "queued"
        }
      ]
    });
  });

  it("passes review-head-gate from terminal posted queue evidence when processed rows are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-queue-posted-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const headSha = "cccccccccccccccccccccccccccccccccccccccc";
    const reviewUrl = `https://github.com/${repo}/pull/${pullNumber}#pullrequestreview-4`;
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    const queueJob = store.enqueueReviewQueueJob({
      repo,
      pullNumber,
      headSha,
      baseSha: "base"
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "posted",
      reviewUrl,
      lastError: "reviewed"
    });
    store.close();

    const { stdout } = await runCli([
      "review-head-gate",
      "--config",
      configPath,
      "--repo",
      repo,
      "--pr",
      String(pullNumber),
      "--head-sha",
      headSha
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      decision: "passed",
      queueJobs: [
        {
          state: "posted",
          reviewUrl
        }
      ]
    });
  });

  it("blocks review-head-gate for readiness-only passes without review proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-head-gate-readiness-proof-"));
    roots.push(root);
    const statePath = join(root, "state.sqlite");
    const configPath = join(root, "config.json");
    const repo = "electricsheephq/evaos-code-review-bot";
    const pullNumber = 181;
    const headSha = "dddddddddddddddddddddddddddddddddddddddd";
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [repo],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    const store = new ReviewStateStore(statePath);
    store.recordReviewReadiness({
      repo,
      pullNumber,
      headSha,
      state: "ready_for_human",
      reason: "dry-run-ready"
    });
    store.close();

    try {
      await runCli([
        "review-head-gate",
        "--config",
        configPath,
        "--repo",
        repo,
        "--pr",
        String(pullNumber),
        "--head-sha",
        headSha
      ]);
      throw new Error("review-head-gate unexpectedly passed");
    } catch (error) {
      const output = JSON.parse((error as { stdout: string }).stdout);
      expect(output).toMatchObject({
        ok: false,
        decision: "blocked",
        readiness: {
          state: "ready_for_human"
        },
        nextAction: expect.stringContaining("resolve the blocked")
      });
    }
  });

  it("requires review-pr repos to be configured and enabled", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/skipped"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      repoProfiles: {
        repos: {
          "owner/skipped": { enabled: false }
        }
      }
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/skipped",
      "--pr",
      "123",
      "--dry-run",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("repo is blocked by repo policy")
    });

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/unconfigured",
      "--pr",
      "123",
      "--dry-run",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("repo must be present in configured repos")
    });
  });

  it("requires explicit confirmation before review-pr live posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-live-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--pr",
      "123",
      "--dry-run",
      "false",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --confirm true")
    });
  });

  it("requires an explicit config file before review-pr live posting", async () => {
    await expect(runCli([
      "review-pr",
      "--repo",
      "owner/repo",
      "--pr",
      "123",
      "--dry-run",
      "false",
      "--confirm",
      "true",
      "--head-sha",
      "abc123",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --config")
    });
  });

  it("requires review-pr live config paths to exist", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-missing-config-"));
    roots.push(root);
    const configPath = join(root, "missing.json");

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--pr",
      "123",
      "--dry-run",
      "false",
      "--confirm",
      "true",
      "--head-sha",
      "abc123",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("config file")
    });
  });

  it("requires an approved head before review-pr live posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-head-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--pr",
      "123",
      "--dry-run",
      "false",
      "--confirm",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --head-sha")
    });
  });

  it("rejects conflicting review-pr live head aliases before posting", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-head-mismatch-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--pr",
      "123",
      "--dry-run",
      "false",
      "--confirm",
      "true",
      "--head-sha",
      "abc123",
      "--expected-head",
      "def456",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("must match")
    });
  });

  it("rejects duplicated review-pr repo flags before policy and execution can diverge", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-duplicate-repo-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--repo",
      "other/repo",
      "--pr",
      "123",
      "--dry-run",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--repo must be provided once")
    });
  });

  it("rejects duplicated review-pr PR flags before execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-duplicate-pr-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--pr",
      "123",
      "--pr",
      "456",
      "--dry-run",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("--pr must be provided once")
    });
  });

  it("returns structured JSON for malformed review-pr PR values", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-pr-bad-pr-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    await expect(runCli([
      "review-pr",
      "--config",
      configPath,
      "--repo",
      "owner/repo",
      "--pr",
      "abc",
      "--dry-run",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("\"command\": \"review-pr\"")
    });
  });

  it("requires review-pr to be scoped to one repo and PR", async () => {
    await expect(runCli([
      "review-pr",
      "--dry-run",
      "true",
      "--zcode",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --repo and --pr")
    });
  });

  it("marks queue output blocked when durable provider-deferred work is ready even if coverage is scoped-ok", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-queue-health-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence"),
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 24 * 60 * 60_000
      },
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "owner/repo": { enabled: false }
        }
      }
    })}\n`);
    const store = new ReviewStateStore(statePath);
    try {
      const job = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-ready",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: job.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-03T00:00:01.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:02.000Z")
      });
      const coolingDown = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 124,
        headSha: "head-cooling-down",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: coolingDown.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2999-01-01T00:00:00.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:02.000Z")
      });
    } finally {
      store.close();
    }

    await expect(runCli(["queue", "--config", configPath, "--state", "provider_deferred"])).rejects.toMatchObject({
      stdout: expect.stringContaining("\"runtimeOk\": false")
    });

    try {
      await runCli(["queue", "--config", configPath, "--state", "provider_deferred"]);
      throw new Error("queue command unexpectedly passed");
    } catch (error) {
      const stdout = (error as { stdout: string }).stdout;
      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: false,
        coverageOk: true,
        runtimeOk: false,
        healthState: "runtime_blocked",
	        durableQueue: {
	          summary: {
	            providerDeferred: 2,
	            retryableProviderDeferred: 1
	          }
	        }
      });
      expect(output.failedGates).toEqual([
        expect.objectContaining({ name: "queue_no_ready_provider_deferred_jobs" })
      ]);
	      expect(output.actionableRows).toEqual([
	        expect.objectContaining({ repo: "owner/repo", pullNumber: 123, state: "provider_deferred" })
	      ]);
	      expect(output.actionableRows.some((row: { pullNumber: number }) => row.pullNumber === 124)).toBe(false);
    }
  });

  it("keeps queue --state provider_deferred blocked by global active provider capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-queue-provider-deferred-capacity-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence"),
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 24 * 60 * 60_000
      },
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "owner/repo": { enabled: false }
        }
      }
    })}\n`);
    const store = new ReviewStateStore(statePath);
    try {
      store.enqueueReviewQueueJob({
        repo: "other/repo",
        pullNumber: 1,
        headSha: "active-head",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      });
      store.leaseNextReviewQueueJobs({
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        leaseTtlMs: 24 * 60 * 60_000,
        now: new Date("2026-07-03T00:00:01.000Z")
      });
      const deferred = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-provider-deferred",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:02.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: deferred.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-03T00:00:03.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:04.000Z")
      });
    } finally {
      store.close();
    }

    try {
      await runCli(["queue", "--config", configPath, "--state", "provider_deferred"]);
      throw new Error("queue command unexpectedly passed");
    } catch (error) {
      const output = JSON.parse((error as { stdout: string }).stdout);
      expect(output).toMatchObject({
        ok: false,
        runtimeOk: false,
        durableQueue: {
          summary: {
            providerDeferred: 1,
            retryableProviderDeferred: 1
          }
        },
        budget: {
          active: {
            total: 1
          },
          providerDeferred: {
            total: 1,
            readyToRetry: 0,
            waitingProviderCapacity: 1
          }
        }
      });
      expect(output.actionableRows).toEqual([]);
      expect(output.failedGates).toEqual([
        expect.objectContaining({ name: "queue_no_ready_provider_deferred_jobs" })
      ]);
    }
  });

  it("keeps queue --repo health scoped to the requested repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-queue-health-scoped-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence"),
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "owner/repo": { enabled: false }
        }
      }
    })}\n`);
    const store = new ReviewStateStore(statePath);
    try {
      const job = store.enqueueReviewQueueJob({
        repo: "other/repo",
        pullNumber: 999,
        headSha: "other-head-ready",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: job.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-03T00:00:01.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:02.000Z")
      });
    } finally {
      store.close();
    }

    let output: Record<string, any>;
    try {
      await runCli(["queue", "--config", configPath, "--repo", "owner/repo"]);
      throw new Error("queue command unexpectedly passed");
    } catch (error) {
      output = JSON.parse((error as { stdout: string }).stdout);
    }
    expect(output).toMatchObject({
      ok: false,
      coverageOk: false,
      runtimeOk: false,
      durableQueue: {
        summary: {
          total: 0,
          providerDeferred: 0,
          retryableProviderDeferred: 0
        }
      },
      budget: {
        providerDeferred: {
          total: 0,
          readyToRetry: 0
        }
      }
    });
    expect(output.failedGates).toEqual([
      expect.objectContaining({ name: "queue_coverage_ok" })
    ]);
  });

  it("marks provider-cooldowns blocked when retryable durable provider-deferred work exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-cooldown-health-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence"),
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 24 * 60 * 60_000
      },
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "owner/repo": { enabled: false }
        }
      }
    })}\n`);
    const store = new ReviewStateStore(statePath);
    try {
      const job = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 124,
        headSha: "head-provider-deferred",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: job.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-03T00:00:01.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:02.000Z")
      });
    } finally {
      store.close();
    }

    try {
      await runCli(["provider-cooldowns", "--config", configPath, "--expired-only", "true", "--repo", "owner/repo"]);
      throw new Error("provider-cooldowns command unexpectedly passed");
    } catch (error) {
      const stdout = (error as { stdout: string }).stdout;
      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: false,
        runtimeOk: false,
        healthState: "provider_cooldowns_actionable",
        summary: {
          expired: 0,
          providerDeferredJobs: 1,
          retryableProviderDeferredJobs: 1,
          readyToRetryProviderDeferredJobs: 1
        }
      });
      expect(output.failedGates).toEqual([
        expect.objectContaining({ name: "provider_cooldowns_no_retryable_provider_deferred_jobs" })
      ]);
      expect(output.recommendedActions).toEqual([
        expect.stringContaining("retry-provider-cooldowns")
      ]);
    }
  });

  it("reports provider-cooldowns backpressured when retryable work waits on active provider capacity", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-cooldown-backpressure-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence"),
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 24 * 60 * 60_000
      },
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "owner/repo": { enabled: false }
        }
      }
    })}\n`);
    const store = new ReviewStateStore(statePath);
    try {
      store.enqueueReviewQueueJob({
        repo: "other/repo",
        pullNumber: 1,
        headSha: "active-head",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      });
      store.leaseNextReviewQueueJobs({
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        leaseTtlMs: 24 * 60 * 60_000,
        now: new Date("2026-07-03T00:00:01.000Z")
      });
      const deferred = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 125,
        headSha: "head-provider-backpressured",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:02.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: deferred.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-03T00:00:03.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:04.000Z")
      });
    } finally {
      store.close();
    }

    try {
      await runCli(["provider-cooldowns", "--config", configPath, "--expired-only", "true", "--repo", "owner/repo"]);
      throw new Error("provider-cooldowns command unexpectedly passed");
    } catch (error) {
      const stdout = (error as { stdout: string }).stdout;
      const output = JSON.parse(stdout);
      expect(output).toMatchObject({
        ok: false,
        runtimeOk: false,
        healthState: "provider_cooldowns_backpressured",
        repo: "owner/repo",
        summary: {
          expired: 0,
          providerDeferredJobs: 1,
          retryableProviderDeferredJobs: 1,
          readyToRetryProviderDeferredJobs: 0,
          waitingProviderCapacity: 1
        }
      });
      expect(output.recommendedActions).toContain(
        "wait for active provider run to finish; retryable provider-deferred jobs are blocked by provider capacity"
      );
    }
  });

  it("keeps provider-cooldowns backpressured under an active provider cooldown", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-cooldown-active-window-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence"),
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 24 * 60 * 60_000
      },
      reviewScheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      },
      repoProfiles: {
        repos: {
          "owner/repo": { enabled: false }
        }
      }
    })}\n`);
    const store = new ReviewStateStore(statePath);
    try {
      store.recordRepoProviderCooldown({
        repo: "other/repo",
        cooldownUntil: new Date("2999-01-01T00:00:00.000Z"),
        reason: "provider_overloaded"
      });
      const deferred = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 126,
        headSha: "head-active-provider-cooldown",
        providerId: "GLM-5.2",
        now: new Date("2026-07-03T00:00:00.000Z")
      }).job;
      store.updateReviewQueueJobState({
        jobId: deferred.jobId,
        state: "provider_deferred",
        nextEligibleAt: "2026-07-03T00:00:01.000Z",
        lastError: "provider_overloaded",
        now: new Date("2026-07-03T00:00:02.000Z")
      });
    } finally {
      store.close();
    }

    try {
      await runCli(["provider-cooldowns", "--config", configPath, "--expired-only", "true", "--repo", "owner/repo"]);
      throw new Error("provider-cooldowns command unexpectedly passed");
    } catch (error) {
      const output = JSON.parse((error as { stdout: string }).stdout);
      expect(output).toMatchObject({
        ok: false,
        runtimeOk: false,
        healthState: "provider_cooldowns_backpressured",
        summary: {
          activeProviderCooldowns: 1,
          providerDeferredJobs: 1,
          retryableProviderDeferredJobs: 1,
          readyToRetryProviderDeferredJobs: 1
        }
      });
      expect(output.recommendedActions).toContain(
        "wait for active provider cooldown to expire before retrying provider-deferred work"
      );
      expect(output.recommendedActions.some((action: string) => action.includes("retry-provider-cooldowns"))).toBe(false);
    }
  });

  it("prints provider throttle telemetry without raw provider payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-throttle-report-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const statePath = join(root, "state.sqlite");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath,
      evidenceDir: join(root, "evidence")
    })}\n`);
    new ReviewStateStore(statePath).close();
    const db = new DatabaseSync(statePath);
    try {
      const recentTimestamp = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .replace(/\.\d+Z$/, "");
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error, created_at)
         values ('owner/repo', 1, 'head-provider-overload', 'failed', ?, ?)`
      ).run("ProviderBusinessError: [1305][temporarily overloaded] providerRequestId: 'secret-request-id'", recentTimestamp);
    } finally {
      db.close();
    }

    const { stdout } = await runCli([
      "provider-throttle-report",
      "--config",
      configPath,
      "--since",
      "7d",
      "--timezone",
      "Asia/Singapore",
      "--peak-start-hour",
      "14",
      "--peak-end-hour",
      "18"
    ]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      recommendedPolicy: "measure_only",
      summary: {
        providerErrors: 1,
        overloaded: 1
      },
      codes: [{ code: "1305", count: 1 }]
    });
    expect(stdout).not.toContain("secret-request-id");
    expect(stdout).not.toContain("ProviderBusinessError");
    expect(stdout).not.toContain("[1305]");
    expect(stdout).not.toContain("temporarily overloaded");
  });

  it("prints launchd daemon control plans in dry-run mode by default", async () => {
    const { stdout: startStdout } = await runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff"
    ]);
    const { stdout: stopStdout } = await runCli([
      "daemon",
      "stop",
      "--launchd-label",
      "com.example.neondiff"
    ]);

    expect(JSON.parse(startStdout)).toMatchObject({
      ok: true,
      command: "daemon start",
      dryRun: true,
      launchdLabel: "com.example.neondiff",
      operation: "kickstart_existing",
      plannedCommands: [["launchctl", "kickstart", "-k", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]]
    });
    expect(JSON.parse(stopStdout)).toMatchObject({
      ok: true,
      command: "daemon stop",
      dryRun: true,
      launchdLabel: "com.example.neondiff",
      operation: "bootout_service",
      plannedCommands: [["launchctl", "bootout", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]]
    });
  });

  it("requires config for daemon status", async () => {
    await expect(runCli([
      "daemon",
      "status",
      "--launchd-label",
      "com.example.neondiff"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("--config is required for daemon status")
    });
  });

  it("validates launchd labels and plist labels before planning daemon commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-plist-"));
    roots.push(root);
    const plistPath = join(root, "com.example.neondiff.plist");
    writeLaunchdPlist(plistPath, "com.example.neondiff");

    const { stdout } = await runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff",
      "--plist",
      plistPath
    ]);

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      command: "daemon start",
      dryRun: true,
      operation: "bootstrap_then_kickstart",
      warning: expect.stringContaining("operator-owned plist paths"),
      plannedCommands: [
        ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath],
        ["launchctl", "kickstart", "-k", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]
      ]
    });

    await expect(runCli([
      "daemon",
      "start",
      "--launchd-label",
      "bad label",
      "--plist",
      plistPath
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("must be a launchd label")
    });
  });

  it("rejects daemon plist files whose Label differs from --launchd-label", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-mismatch-"));
    roots.push(root);
    const plistPath = join(root, "wrong.plist");
    writeLaunchdPlist(plistPath, "com.example.other");

    await expect(runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff",
      "--plist",
      plistPath
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("must match --launchd-label")
    });
  });

  it("requires explicit confirmation before launchd daemon mutation", async () => {
    await expect(runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff",
      "--dry-run",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --confirm true")
    });
  });

  it("requires an explicit override for live daemon mutation with an external plist", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-external-"));
    roots.push(root);
    const plistPath = join(root, "com.example.neondiff.plist");
    writeLaunchdPlist(plistPath, "com.example.neondiff");

    await expect(runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff",
      "--plist",
      plistPath,
      "--dry-run",
      "false",
      "--confirm",
      "true"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --allow-external-plist true")
    });
  });

  it("keeps daemon subcommands separate from the legacy cycle loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-daemon-loop-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      pollIntervalMs: 60_000
    })}\n`);

    await expect(runCli(["daemon", "bad-subcommand"])).rejects.toMatchObject({
      stderr: expect.stringContaining("daemon subcommand must be one of")
    });
    // Empty temp repo config keeps runDaemonCycle local-only while proving dispatch.
    await expect(runCli([
      "daemon",
      "--config",
      configPath,
      "--dry-run",
      "true",
      "--once",
      "true"
    ])).resolves.toMatchObject({
      stdout: expect.stringContaining("daemon_cycle_start")
    });
  });
});

async function runCli(args: string[], options: { cwd?: string; timeout?: number } = {}) {
  return execFileAsync(process.execPath, [tsxCliPath, join(repoRoot, "src/cli.ts"), ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      EVAOS_REVIEW_BOT_APP_ID: "",
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "",
      GITHUB_TOKEN: ""
    },
    timeout: options.timeout ?? 15_000,
    killSignal: "SIGTERM",
    maxBuffer: 1024 * 1024
  });
}

function writeLaunchdPlist(path: string, label: string): void {
  writeFileSync(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/true</string>
  </array>
</dict>
</plist>
`);
}
