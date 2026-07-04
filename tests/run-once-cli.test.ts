import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePositiveInteger } from "../src/cli-args.js";
import { buildRunOnceCliReport, runOnceCliCommand, runOnceCliExitCode, serializeRunOnceCliReport } from "../src/run-once-cli.js";
import { assertExpectedReviewPrHead, type RunOnceResult } from "../src/worker.js";

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

  it("prints review-pr as the command on successful review-pr invocations", async () => {
    let forwardedExpectedHeadSha: string | undefined;
    const command = await runOnceCliCommand({
      options: {
        dryRun: true,
        repo: "owner/repo",
        pullNumber: 123,
        expectedHeadSha: "head-123",
        useZCode: false
      },
      commandName: "review-pr",
      runOnceImpl: async (options) => {
        forwardedExpectedHeadSha = options.expectedHeadSha;
        return runOnceResult({
          reposScanned: 1,
          pullsSeen: 1,
          reviewed: 1,
          scopedPull: {
            repo: "owner/repo",
            pullNumber: 123,
            headSha: "head-123",
            title: "reviewed",
            url: "https://github.com/owner/repo/pull/123"
          }
        });
      }
    });

    expect(command.exitCode).toBe(0);
    expect(forwardedExpectedHeadSha).toBe("head-123");
    expect(command.report.command).toBe("review-pr");
    expect(JSON.parse(command.output)).toMatchObject({
      ok: true,
      command: "review-pr",
      scope: {
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-123"
      }
    });
  });

  it("rejects review-pr execution when the fetched PR head differs from the approved head", () => {
    expect(() => assertExpectedReviewPrHead({
      repo: "owner/repo",
      pullNumber: 123,
      expectedHeadSha: "approved-head",
      currentHeadSha: "advanced-head"
    })).toThrow("review-pr expected head mismatch for owner/repo#123: expected=approved-head current=advanced-head");
  });

  it("marks failed reviews as non-ok and requests a nonzero exit code", () => {
    const result = runOnceResult({ failed: 1 });

    expect(buildRunOnceCliReport({
      result,
      dryRun: false,
      useZCode: true
    })).toMatchObject({
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

  it("keeps broad-scan license gate skips ok so intentional proof blocks do not fail the sweep", () => {
    const result = runOnceResult({
      skippedPolicy: 1,
      skippedLicenseGate: 1
    });

    expect(buildRunOnceCliReport({
      result,
      dryRun: false,
      useZCode: true
    })).toMatchObject({
      ok: true,
      result: {
        skippedPolicy: 1,
        skippedLicenseGate: 1
      }
    });
    expect(runOnceCliExitCode(result)).toBe(0);
  });

  it("marks scoped license gate skips as non-ok and requests a nonzero exit code", () => {
    const result = runOnceResult({
      skippedLicenseGate: 1,
      scopedPull: {
        repo: "owner/private",
        pullNumber: 123,
        headSha: "head-123",
        title: "private change",
        url: "https://github.com/owner/private/pull/123"
      }
    });

    expect(buildRunOnceCliReport({
      result,
      dryRun: false,
      useZCode: true,
      repo: "owner/private",
      pullNumber: 123
    })).toMatchObject({
      ok: false,
      scope: {
        repo: "owner/private",
        pullNumber: 123,
        headSha: "head-123"
      },
      result: {
        skippedLicenseGate: 1
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

  it("prints review-pr as the command when review-pr execution throws", async () => {
    const command = await runOnceCliCommand({
      options: {
        dryRun: true,
        repo: "owner/repo",
        pullNumber: 123,
        useZCode: false
      },
      commandName: "review-pr",
      runOnceImpl: async () => {
        throw new Error("GitHub API fetch failed for /repos/owner/repo/pulls/123");
      }
    });

    expect(command.exitCode).toBe(1);
    expect(command.report.ok).toBe(false);
    expect(JSON.parse(command.output)).toMatchObject({
      ok: false,
      command: "review-pr",
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
    skippedLicenseGate: 0,
    skippedCommandStop: 0,
    skippedCommandExplain: 0,
    skippedFinishingTouchDraft: 0,
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
