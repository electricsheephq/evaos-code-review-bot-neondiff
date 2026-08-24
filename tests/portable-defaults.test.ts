import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runOfflineEval, type EvalScenarioInput } from "../src/eval-harness.js";

const sourceSurfaces = [
  "src/config.ts",
  "config.example.json",
  "src/eval-harness.ts",
  "src/cli.ts",
  "launchd/evaos-code-review-bot.plist.example",
  "apps/neondiff-desktop/Sources/NeonDiffDesktopCoreSmoke/main.swift"
];

const workstationPathPattern = new RegExp([
  ["/Volumes", "LEXAR"].join("/"),
  ["/Users", "m1"].join("/")
].join("|"));

describe("portable defaults and supported LaunchAgent example", () => {
  it("keeps compatibility defaults user-local and native Codex login explicit", () => {
    const config = loadConfig();
    expect(config.skillPacks).toMatchObject({
      enabled: false,
      skillRoot: join(homedir(), ".neondiff", "skills")
    });
    expect(config.zcode.appConfigPath).toBe(join(homedir(), ".zcode", "v2", "config.json"));
    expect(config.codexRuntime).toMatchObject({ enabled: false, model: "gpt-5.6-luna" });
  });

  it("uses an external portable root when the offline eval API has no output override", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-portable-eval-"));
    const previous = process.env.NEONDIFF_EVIDENCE_ROOT;
    process.env.NEONDIFF_EVIDENCE_ROOT = root;
    try {
      const scenario: EvalScenarioInput = {
        runId: "portable-default",
        repo: "owner/repo",
        pullNumber: 1,
        headSha: "abc123",
        suite: "canary_shadow",
        botFindings: { findings: [] },
        labels: []
      };
      const result = runOfflineEval(scenario, { now: new Date("2026-07-01T00:00:00Z") });
      expect(result.outputDir).toBe(join(root, "2026-07-01", "portable-default"));
      expect(result.outputDir.startsWith(process.cwd())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEONDIFF_EVIDENCE_ROOT;
      else process.env.NEONDIFF_EVIDENCE_ROOT = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("contains no active workstation paths in the owned source/example surfaces", () => {
    for (const path of sourceSurfaces) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(workstationPathPattern);
    }
  });

  it("keeps the supported plist on the signed wrapper and Keychain-only boundary", () => {
    const plist = readFileSync("launchd/evaos-code-review-bot.plist.example", "utf8");
    expect(plist).toContain("/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop");
    expect(plist).toContain("--neondiff-worker-daemon");
    expect(plist).toContain("Library/Application Support/NeonDiffDesktop/Accounts/");
    expect(plist).toContain("--launchd-label");
    expect(plist).toContain("--runtime-credentials-stdin true");
    expect(plist).toContain("Contents/Helpers/NeonDiffWorker");
    expect(plist).toContain("Keychain-only");
    expect(plist).toContain("Desktop Preview Start");
    expect(plist).toContain("gated generated installation");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
    expect(plist).not.toContain("EnvironmentVariables");
    expect(plist).not.toMatch(/node_modules|tsx|private-key|secret|token/i);
  });
});
