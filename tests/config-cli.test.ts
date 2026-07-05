import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { patchConfigForDesktop } from "../src/config-cli.js";

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
        token: "ghp_fake_token"
      },
      notes: {
        customProviderHeader: "Bearer custom-provider-token-1234567890"
      },
      customSecret: {
        nestedKeyName: "not-secret-shaped-but-container-is"
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
    expect(output.editablePaths).toContain("providers.defaultProviderId");
    expect(output.editablePaths).toContain("providers.providers.<provider-id>.<desktop-safe-provider-field>");
    expect(output.editablePaths).not.toContain("github.apiBaseUrl");
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
    expect(output.config.notes.customProviderHeader).toBe("[redacted-secret]");
    expect(output.config.customSecret).toBe("[redacted-secret]");
  });

  it("redacts empty secret values consistently", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      github: {
        token: "",
        privateKeyPath: null
      }
    });

    const output = await runConfig(["config", "inspect", "--config", configPath]);

    expect(output.config.github).toMatchObject({
      token: "[redacted-secret]",
      privateKeyPath: null
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

  it("dry-runs provider metadata patches without allowing provider secrets", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    const secretPatchPath = join(root, "secret-provider-patch.json");
    const secretApiKeyEnvPatchPath = join(root, "secret-provider-env-patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(patchPath, {
      providers: {
        defaultProviderId: "ollama-local",
        providers: {
          "ollama-local": {
            enabled: true,
            baseUrl: "http://localhost:11434/v1",
            model: "qwen2.5-coder:14b",
            authMode: "none",
            capabilities: {
              review: true,
              jsonOutput: true
            }
          },
          "openai-compatible": {
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY"
          }
        }
      }
    });
    writeConfig(secretPatchPath, {
      providers: {
        providers: {
          "openai-compatible": {
            baseUrl: "https://gateway.example.test/v1?api_key=sk-fixture-secret"
          }
        }
      }
    });
    writeConfig(secretApiKeyEnvPatchPath, {
      providers: {
        providers: {
          "openai-compatible": {
            apiKeyEnv: "sk-fixture-secret"
          }
        }
      }
    });

    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      wrote: false,
      changedPaths: [
        "providers.defaultProviderId",
        "providers.providers.ollama-local.enabled",
        "providers.providers.ollama-local.baseUrl",
        "providers.providers.ollama-local.model",
        "providers.providers.ollama-local.authMode",
        "providers.providers.ollama-local.capabilities.review",
        "providers.providers.ollama-local.capabilities.jsonOutput",
        "providers.providers.openai-compatible.apiKeyEnv"
      ]
    });
    expect(output.config.providers.defaultProviderId).toBe("ollama-local");
    expect(output.config.providers.providers["openai-compatible"].apiKeyEnv).toBe("NEONDIFF_PROVIDER_API_KEY");

    const rejected = await runConfig(["config", "patch", "--config", configPath, "--input", secretPatchPath]);
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret-like text")
    });
    expect(JSON.stringify(rejected)).not.toContain("sk-live-secret");
    const rejectedApiKeyEnv = await runConfig(["config", "patch", "--config", configPath, "--input", secretApiKeyEnvPatchPath]);
    expect(rejectedApiKeyEnv).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret-like text")
    });
    expect(JSON.stringify(rejectedApiKeyEnv)).not.toContain("sk-live-secret");
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

  it("keeps default patch mode dry-run even when confirm is true", async () => {
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
      }
    });
    writeConfig(patchPath, {
      desktop: {
        updateChannel: "beta"
      }
    });
    const before = readFileSync(configPath, "utf8");

    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath, "--confirm", "true"]);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      wrote: false,
      changedPaths: ["desktop.updateChannel"]
    });
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  it("rejects secrets and non-desktop-safe patch paths", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const secretPatchPath = join(root, "secret-patch.json");
    const licensePatchPath = join(root, "license-patch.json");
    const blockedPatchPath = join(root, "blocked-patch.json");
    const sensitivePathPatchPath = join(root, "sensitive-path-patch.json");
    const flatDottedPatchPath = join(root, "flat-dotted-patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(secretPatchPath, {
      github: { token: "ghp_fake_token" }
    });
    writeConfig(licensePatchPath, {
      desktop: { updateChannel: "NEONDIFF-PRIVATE-1234567890123456" }
    });
    writeConfig(blockedPatchPath, {
      pollIntervalMs: 120_000
    });
    writeConfig(sensitivePathPatchPath, {
      "NDL_SECRETLIKEPATH12345": "not-a-secret-value"
    });
    writeConfig(flatDottedPatchPath, {
      "zcode.cliPath": "/new/bin/neondiff"
    });

    expect(await runConfig(["config", "patch", "--config", configPath, "--input", secretPatchPath])).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret-like text")
    });
    const licenseRejected = await runConfig(["config", "patch", "--config", configPath, "--input", licensePatchPath]);
    expect(licenseRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret-like text")
    });
    expect(JSON.stringify(licenseRejected)).not.toContain("NEONDIFF-PRIVATE-1234567890123456");
    expect(await runConfig(["config", "patch", "--config", configPath, "--input", blockedPatchPath])).toMatchObject({
      ok: false,
      error: expect.stringContaining("non-desktop-safe path")
    });
    const sensitivePathRejected = await runConfig(["config", "patch", "--config", configPath, "--input", sensitivePathPatchPath]);
    expect(sensitivePathRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("secret-like text")
    });
    expect(JSON.stringify(sensitivePathRejected)).not.toContain("NDL_SECRETLIKEPATH12345");
    const flatDottedRejected = await runConfig(["config", "patch", "--config", configPath, "--input", flatDottedPatchPath]);
    expect(flatDottedRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsupported dotted key segment")
    });
    expect(JSON.stringify(flatDottedRejected)).not.toContain("/new/bin/neondiff");
  });

  it("keeps GitHub API base URL out of desktop-safe patches", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(patchPath, {
      github: { apiBaseUrl: "https://example.invalid" }
    });

    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);

    expect(output).toMatchObject({
      ok: false,
      error: expect.stringContaining("non-desktop-safe path")
    });
    expect(output.error).toContain("github.apiBaseUrl");
  });

  it("rejects empty ZCode string settings before live desktop writes", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(patchPath, {
      zcode: {
        cliPath: "",
        appConfigPath: "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
        model: "GLM-5.2"
      }
    });

    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);

    expect(output).toMatchObject({
      ok: false,
      error: expect.stringContaining("config.zcode.cliPath must be a non-empty string")
    });
  });

  it("rejects invalid live patches before creating temp config files", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      zcode: {
        cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        appConfigPath: "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
        model: "GLM-5.2"
      }
    });
    writeConfig(patchPath, {
      zcode: {
        cliPath: "",
        appConfigPath: "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
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
      ok: false,
      wrote: false,
      error: expect.stringContaining("config.zcode.cliPath must be a non-empty string")
    });
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("removes temp config files when an atomic live write fails", () => {
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
      }
    });
    const before = readFileSync(configPath, "utf8");
    writeConfig(patchPath, {
      desktop: {
        updateChannel: "beta"
      }
    });

    const output = patchConfigForDesktop({
      configPath,
      inputPath: patchPath,
      dryRun: false,
      confirm: true,
      fileOps: {
        renameSync: () => {
          throw new Error("forced rename failure");
        }
      }
    });

    expect(output).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("failed to write config atomically")
    });
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(readdirSync(root).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("rejects empty object patches with a clear message", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(patchPath, {});

    await expect(runConfig(["config", "patch", "--config", configPath, "--input", patchPath])).resolves.toMatchObject({
      ok: false,
      error: "patch input did not contain any leaf settings"
    });
  });

  it("rejects ambiguous repeated config inspect path arguments", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });

    await expect(runConfigRaw(["config", "inspect", "--config", configPath, "--config", configPath])).rejects.toMatchObject({
      stderr: expect.stringContaining("--config must be provided once")
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
    try {
      const { stdout } = await runConfigRaw(args);
      return JSON.parse(stdout);
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout ?? "";
      if (!stdout) throw error;
      return JSON.parse(stdout);
    }
  }

  async function runConfigRaw(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const {
      EVAOS_REVIEW_BOT_APP_ID,
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH,
      GITHUB_TOKEN,
      ...safeEnv
    } = process.env;
    return execFileAsync(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: safeEnv,
      maxBuffer: 1024 * 1024
    });
  }
});
