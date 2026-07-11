import { describe, expect, it } from "vitest";
import { classifyCommandLicensePolicy } from "../src/command-license-policy.js";

describe("default-deny command license policy", () => {
  it.each([
    ["init", undefined],
    ["config", "inspect"],
    ["config", "patch"],
    ["pricing", undefined],
    ["license", "activate"],
    ["license", "status"],
    ["license", "deactivate"],
    ["providers", "list"],
    ["providers", "doctor"],
    ["dashboard", undefined],
    ["daemon", "stop"],
    ["daemon", "status"],
    ["eval-offline", undefined],
    ["eval-suite", undefined]
  ])("keeps setup-safe %s %s available", (command, subcommand) => {
    expect(classifyCommandLicensePolicy({ command, subcommand })).toEqual({ mode: "setup_safe" });
  });

  it.each([
    [{ command: "providers", subcommand: "verify" }, "provider_verify"],
    [{ command: "providers", subcommand: "doctor", smoke: true }, "provider_smoke"],
    [{ command: "review-pr" }, "review_cycle"],
    [{ command: "run-once" }, "review_cycle"],
    [{ command: "coverage", coverageBacked: true }, "review_discovery"],
    [{ command: "status", coverageBacked: true }, "review_discovery"],
    [{ command: "runtime-inventory", coverageBacked: true }, "review_discovery"],
    [{ command: "queue", coverageBacked: true }, "review_discovery"],
    [{ command: "dashboard", coverageBacked: true }, "review_discovery"],
    [{ command: "release-status", coverageBacked: true }, "review_discovery"],
    [{ command: "retry-failed" }, "review_cycle"],
    [{ command: "retry-provider-cooldowns" }, "review_cycle"],
    [{ command: "daemon", subcommand: "start", dryRun: false }, "daemon_cycle"],
    [{ command: "daemon" }, "daemon_cycle"],
    [{ command: "issue-enrichment-run" }, "issue_enrichment"]
  ] as const)("requires $1 for $0", (input, operation) => {
    expect(classifyCommandLicensePolicy(input)).toEqual({ mode: "requires_license", operation });
  });

  it("defaults unknown future commands to live admission", () => {
    expect(classifyCommandLicensePolicy({ command: "future-useful-command" })).toEqual({
      mode: "requires_license",
      operation: "review_cycle"
    });
  });
});
