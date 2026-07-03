import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

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
      "doctor",
      "daemon start",
      "daemon stop",
      "daemon status",
      "status",
      "review-pr"
    ]);
    expect(output.examples).toContain("neondiff init --config config.local.json");
    expect(output.examples).toContain("npx tsx src/cli.ts daemon --config /path/to/live.json --dry-run true --once true");
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
