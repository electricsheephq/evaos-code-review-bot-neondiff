import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePositiveInteger } from "../src/cli-args.js";
import { buildRunOnceCliReport, runOnceCliCommand, runOnceCliExitCode, serializeRunOnceCliReport } from "../src/run-once-cli.js";
import type { RunOnceResult } from "../src/worker.js";

describe("run-once CLI reporting", () => {
  it("prints invocation metadata with the structured runOnce result", () => {
    const result = runOnceResult({
      reposScanned: 1,
      pullsSeen: 1,
      reviewed: 1,
      baselinedExisting: 2,
      scopedPull: {
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-123",
        title: "Improve operator output",
        url: "https://github.com/owner/repo/pull/123"
      }
    });

    expect(buildRunOnceCliReport({
      result,
      dryRun: true,
      useZCode: false,
      repo: "owner/repo",
      pullNumber: 123
    })).toEqual({
      ok: true,
      command: "run-once",
      dryRun: true,
      useZCode: false,
      scope: {
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-123",
        url: "https://github.com/owner/repo/pull/123"
      },
      result
    });
  });

  it("marks failed reviews as non-ok and requests a nonzero exit code", () => {
    const result = runOnceResult({ failed: 1 });

    expect(buildRunOnceCliReport({ result, dryRun: false, useZCode: true })).toMatchObject({
      ok: false,
      dryRun: false,
      useZCode: true,
      scope: {},
      result: {
        failed: 1
      }
    });
    expect(runOnceCliExitCode(result)).toBe(1);
  });

  it("returns nonzero command output when an injected runOnce implementation reports failures", async () => {
    const command = await runOnceCliCommand({
      options: {
        dryRun: false,
        repo: "owner/repo",
        pullNumber: 123,
        useZCode: true
      },
      runOnceImpl: async () => runOnceResult({
        reposScanned: 1,
        pullsSeen: 1,
        failed: 1,
        scopedPull: {
          repo: "owner/repo",
          pullNumber: 123,
          headSha: "head-123",
          title: "broken review",
          url: "https://github.com/owner/repo/pull/123"
        }
      })
    });

    expect(command.exitCode).toBe(1);
    expect(command.report.ok).toBe(false);
    expect(JSON.parse(command.output)).toMatchObject({
      ok: false,
      dryRun: false,
      scope: {
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-123"
      },
      result: {
        failed: 1
      }
    });
  });

  it("returns structured command output when runOnce throws during execution", async () => {
    const command = await runOnceCliCommand({
      options: {
        dryRun: true,
        repo: "owner/repo",
        pullNumber: 123,
        useZCode: false
      },
      runOnceImpl: async () => {
        throw new Error("GitHub API fetch failed for /repos/owner/repo/pulls/123");
      }
    });

    expect(command.exitCode).toBe(1);
    expect(command.report.ok).toBe(false);
    expect(JSON.parse(command.output)).toMatchObject({
      ok: false,
      command: "run-once",
      dryRun: true,
      useZCode: false,
      scope: {
        repo: "owner/repo",
        pullNumber: 123
      },
      error: {
        message: "GitHub API fetch failed for /repos/owner/repo/pulls/123"
      }
    });
  });

  it("redacts secret-like text from serialized operator output", () => {
    const report = buildRunOnceCliReport({
      result: runOnceResult({
        scopedPull: {
          repo: "owner/repo",
          pullNumber: 123,
          headSha: "head-123",
          title: "fix leak ghp_123456789012345678901234",
          url: "https://github.com/owner/repo/pull/123"
        }
      }),
      dryRun: true,
      useZCode: true,
      repo: "owner/repo",
      pullNumber: 123
    });

    const output = serializeRunOnceCliReport(report);

    expect(output).toContain("[redacted-secret]");
    expect(output).not.toContain("ghp_123456789012345678901234");
    expect(JSON.parse(output).result.scopedPull.title).toBe("fix leak [redacted-secret]");
  });

  it("keeps serialized operator output parseable when redacting structured secret text", () => {
    const report = buildRunOnceCliReport({
      result: runOnceResult({
        scopedPull: {
          repo: "owner/repo",
          pullNumber: 123,
          headSha: "head-123",
          title: [
            'fix leak {"token":"abcdefghijklmnop"}',
            '{"api_key":"qrstuvwxyz123456"}',
            'password="secretpassword12345"',
            "and -----BEGIN PRIVATE KEY----- secret"
          ].join(" "),
          url: "https://github.com/owner/repo/pull/123"
        }
      }),
      dryRun: true,
      useZCode: true,
      repo: "owner/repo",
      pullNumber: 123
    });

    const output = serializeRunOnceCliReport(report);
    const parsed = JSON.parse(output);

    expect(output).toContain("[redacted-secret]");
    for (const forbidden of ["abcdefghijklmnop", "qrstuvwxyz123456", "secretpassword12345"]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).not.toContain("PRIVATE KEY");
    expect(parsed.result.scopedPull.title).toContain("[redacted-secret]");
  });

  it("prints JSON from the run-once command without contacting GitHub for policy-skipped repos", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-run-once-cli-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["owner/skipped"],
        workRoot: join(dir, "runtime"),
        statePath: join(dir, "state.sqlite"),
        evidenceDir: join(dir, "evidence"),
        repoProfiles: {
          repos: {
            "owner/skipped": { enabled: false }
          }
        }
      })}\n`);

      const result = await runOnceCliCommand({
        options: {
          configPath,
          repo: "owner/skipped",
          dryRun: true,
          useZCode: false
        }
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.output);
      expect(output).toMatchObject({
        ok: true,
        command: "run-once",
        dryRun: true,
        useZCode: false,
        scope: { repo: "owner/skipped" },
        result: {
          reposScanned: 1,
          pullsSeen: 0,
          reviewed: 0,
          skippedPolicy: 1,
          policySkips: [{ repo: "owner/skipped", reason: "repo_profile_disabled" }]
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints JSON for explicit live-mode run-once invocations without posting when repo policy skips", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-run-once-cli-live-"));
    try {
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["owner/skipped"],
        workRoot: join(dir, "runtime"),
        statePath: join(dir, "state.sqlite"),
        evidenceDir: join(dir, "evidence"),
        repoProfiles: {
          repos: {
            "owner/skipped": { enabled: false }
          }
        }
      })}\n`);

      const result = await runOnceCliCommand({
        options: {
          configPath,
          repo: "owner/skipped",
          dryRun: false,
          useZCode: false
        }
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.output);
      expect(output).toMatchObject({
        ok: true,
        command: "run-once",
        dryRun: false,
        useZCode: false,
        scope: { repo: "owner/skipped" },
        result: {
          reposScanned: 1,
          pullsSeen: 0,
          reviewed: 0,
          skippedPolicy: 1,
          policySkips: [{ repo: "owner/skipped", reason: "repo_profile_disabled" }]
        }
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects non-positive or malformed pull numbers before printing scoped metadata", () => {
    for (const pr of ["abc", "0"]) {
      expect(() => parsePositiveInteger(pr, "--pr")).toThrow("--pr must be a positive integer");
    }
  });
});

function runOnceResult(overrides: Partial<RunOnceResult> = {}): RunOnceResult {
  return {
    reposScanned: 0,
    pullsSeen: 0,
    reviewed: 0,
    failed: 0,
    skippedDraft: 0,
    skippedCanary: 0,
    skippedPolicy: 0,
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
    commandReviewRequested: 0,
    skippedProcessed: 0,
    skippedCapacity: 0,
    skippedProviderCooldown: 0,
    skippedStaleHead: 0,
    baselinedExisting: 0,
    policySkips: [],
    ...overrides
  };
}
