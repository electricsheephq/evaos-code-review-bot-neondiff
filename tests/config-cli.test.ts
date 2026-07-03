import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

describe("desktop config CLI", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("inspects effective config with secret-bearing fields redacted", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      github: {
        appId: "123",
        privateKeyPath: join(root, "private-key.pem"),
        token: "ghp_123456789012345678901234567890123456"
      }
    });

    const output = await runConfig(["config", "inspect", "--config", configPath]);

    expect(output).toMatchObject({
      ok: true,
      command: "config inspect",
      exists: true,
      source: "file"
    });
    expect(output.editablePaths).toContain("zcode.model");
    expect(output.editablePaths).toContain("desktop.openAICompatibleEndpoint");
    expect(output.editablePaths).toContain("github.appId");
    expect(output.editablePaths).not.toContain("github.privateKeyPath");
    expect(output.editablePaths).not.toContain("workRoot");
    expect(output.config.desktop).toMatchObject({
      openAICompatibleEndpoint: "http://localhost:8000/v1",
      updateChannel: "dev"
    });
    expect(JSON.stringify(output)).not.toContain("ghp_");
    expect(JSON.stringify(output)).not.toContain("private-key.pem");
    expect(output.config.github).toMatchObject({
      appId: "123",
      privateKeyPath: "[redacted-secret]",
      token: "[redacted-secret]"
    });
  });

  it("dry-runs whitelisted non-secret patches without writing", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      zcode: { model: "GLM-5.2" },
      unknownDesktopFuture: { keep: true }
    });
    writeConfig(patchPath, {
      zcode: { model: "GLM-5.2-Air" },
      repoProfiles: {
        repos: {
          "owner/repo": {
            enabled: true,
            suggestedLabels: ["desktop"]
          }
        }
      },
      desktop: {
        openAICompatibleEndpoint: "http://localhost:8001/v1",
        updateChannel: "beta"
      }
    });

    const before = readFileSync(configPath, "utf8");
    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);

    expect(output).toMatchObject({
      ok: true,
      command: "config patch",
      dryRun: true,
      wrote: false,
      changedPaths: [
        "zcode.model",
        "repoProfiles.repos.owner/repo.enabled",
        "repoProfiles.repos.owner/repo.suggestedLabels",
        "desktop.openAICompatibleEndpoint",
        "desktop.updateChannel"
      ]
    });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(output.config.zcode.model).toBe("GLM-5.2-Air");
    expect(output.config.desktop.openAICompatibleEndpoint).toBe("http://localhost:8001/v1");
  });

  it("requires confirm for live writes, then writes atomically while preserving unknown fields", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      pollIntervalMs: 90_000,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      unknownDesktopFuture: { keep: true }
    });
    chmodSync(configPath, 0o600);
    writeConfig(patchPath, {
      desktop: {
        updateChannel: "beta"
      },
      zcode: {
        cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        appConfigPath: "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
        model: "GLM-5.2",
        timeoutMs: 200_000
      }
    });

    const rejected = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath, "--dry-run", "false"]);
    expect(rejected).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("requires --confirm true")
    });

    const output = await runConfig([
      "config",
      "patch",
      "--config",
      configPath,
      "--input",
      patchPath,
      "--dry-run",
      "false",
      "--confirm",
      "true"
    ]);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    const mode = statSync(configPath).mode & 0o777;

    expect(output.ok).toBe(true);
    expect(output.wrote).toBe(true);
    expect(written.pollIntervalMs).toBe(90_000);
    expect(written.desktop.updateChannel).toBe("beta");
    expect(written.zcode.timeoutMs).toBe(200_000);
    expect(written.unknownDesktopFuture).toEqual({ keep: true });
    expect(mode).toBe(0o600);
    expect(existsSync(configPath)).toBe(true);
  });

  it("reports no-op patch leaves separately and skips redundant live writes", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      desktop: {
        updateChannel: "dev"
      },
      zcode: {
        model: "GLM-5.2"
      }
    });
    const before = readFileSync(configPath, "utf8");
    writeConfig(patchPath, {
      desktop: {
        updateChannel: "dev"
      },
      zcode: {
        model: "GLM-5.2"
      }
    });

    const output = await runConfig([
      "config",
      "patch",
      "--config",
      configPath,
      "--input",
      patchPath,
      "--dry-run",
      "false",
      "--confirm",
      "true"
    ]);

    expect(output).toMatchObject({
      ok: true,
      wrote: false,
      changedPaths: [],
      noopPaths: ["desktop.updateChannel", "zcode.model"]
    });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects secrets and non-desktop-safe patch paths", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const secretPatchPath = join(root, "secret-patch.json");
    const blockedPatchPath = join(root, "blocked-patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(secretPatchPath, {
      github: { token: "ghp_123456789012345678901234567890123456" }
    });
    writeConfig(blockedPatchPath, {
      workRoot: join(root, "runtime-bypass")
    });

    expect(await runConfig(["config", "patch", "--config", configPath, "--input", secretPatchPath])).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret-like text")
    });
    expect(await runConfig(["config", "patch", "--config", configPath, "--input", blockedPatchPath])).toMatchObject({
      ok: false,
      error: expect.stringContaining("non-desktop-safe path")
    });
  });

  function mkRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "neondiff-config-cli-"));
    roots.push(root);
    return root;
  }

  function writeConfig(path: string, value: Record<string, unknown>): void {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  async function runConfig(args: string[]): Promise<Record<string, any>> {
    const {
      EVAOS_REVIEW_BOT_APP_ID,
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH,
      GITHUB_TOKEN,
      ...safeEnv
    } = process.env;
    try {
      const { stdout } = await execFileAsync(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
        cwd: process.cwd(),
        env: safeEnv,
        maxBuffer: 1024 * 1024
      });
      return JSON.parse(stdout);
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      if (!stdout) throw error;
      return JSON.parse(stdout);
    }
  }
});
