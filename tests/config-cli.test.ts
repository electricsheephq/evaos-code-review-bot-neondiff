import { execFile } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { inspectConfigForDesktop, patchConfigForDesktop } from "../src/config-cli.js";

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
    expect(output.editablePaths).toContain("github.clientId");
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
    expect(output.config.license).toMatchObject({
      enabled: true,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      offlineGraceMs: 0,
      publicReposFree: false,
      privateReposRequireEntitlement: true,
      productionPolicy: { mode: "mandatory_online" }
    });
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

  it("retries inspect when the config changes during its stable read", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const config = {
      pilotRepos: ["owner/repo"],
      pollIntervalMs: 90_000,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    };
    writeConfig(configPath, config);

    let injectedWrite = false;
    const hookedReadFileSync = ((path: Parameters<typeof readFileSync>[0], options?: unknown) => {
      const text = readFileSync(path, options as BufferEncoding);
      if (!injectedWrite) {
        injectedWrite = true;
        writeConfig(configPath, { ...JSON.parse(text), pollIntervalMs: 120_000 });
      }
      return text;
    }) as typeof readFileSync;
    const inspected = inspectConfigForDesktop(configPath, { readFileSync: hookedReadFileSync });
    const current = inspectConfigForDesktop(configPath);

    expect(injectedWrite).toBe(true);
    expect((inspected.config as { pollIntervalMs: number }).pollIntervalMs).toBe(120_000);
    expect(inspected.revision).toBe(current.revision);
  });

  it("returns a structured inspect failure when a stable snapshot cannot be obtained", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      pollIntervalMs: 90_000,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });

    let pollIntervalMs = 90_000;
    const hookedReadFileSync = ((path: Parameters<typeof readFileSync>[0], options?: unknown) => {
      const text = readFileSync(path, options as BufferEncoding);
      pollIntervalMs += 1_000;
      writeConfig(configPath, { ...JSON.parse(text), pollIntervalMs });
      return text;
    }) as typeof readFileSync;
    const inspected = inspectConfigForDesktop(configPath, { readFileSync: hookedReadFileSync });

    expect(inspected).toMatchObject({
      ok: false,
      command: "config inspect",
      revision: "",
      error: expect.stringContaining("config changed while reading")
    });
    expect(inspected.config).toBeUndefined();
  });

  it("retries a transient torn JSON read before failing closed", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      pollIntervalMs: 90_000,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    let reads = 0;
    const hookedReadFileSync = ((path: Parameters<typeof readFileSync>[0], options?: unknown) => {
      reads += 1;
      return reads === 1 ? "{" : readFileSync(path, options as BufferEncoding);
    }) as typeof readFileSync;

    const inspected = inspectConfigForDesktop(configPath, { readFileSync: hookedReadFileSync });

    expect(inspected.ok).toBe(true);
    expect(reads).toBe(2);
    expect((inspected.config as { pollIntervalMs: number }).pollIntervalMs).toBe(90_000);
  });

  it("changes the revision when content changes even with fixed metadata", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const config = {
      pilotRepos: ["owner/repo"],
      pollIntervalMs: 90_000,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    };
    writeConfig(configPath, config);
    const fixedStat = statSync(configPath, { bigint: true });
    const fixedStatSync = (() => fixedStat) as unknown as typeof statSync;
    const before = inspectConfigForDesktop(configPath, { statSync: fixedStatSync });
    writeConfig(configPath, { ...config, pollIntervalMs: 91_000 });
    const after = inspectConfigForDesktop(configPath, { statSync: fixedStatSync });

    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    expect(after.revision).not.toBe(before.revision);
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
    const inspected = await runConfig(["config", "inspect", "--config", configPath]);
    expect(inspected.revision).toMatch(/^[a-f0-9]{64}$/);

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
            retrySchemaFeedbackMax: 1,
            structuredOutputMode: "ollama-format-json-schema",
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
        "providers.providers.ollama-local.retrySchemaFeedbackMax",
        "providers.providers.ollama-local.structuredOutputMode",
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

    const emptyRevisionRejected = await runConfig([
      "config", "patch", "--config", configPath, "--input", patchPath,
      "--dry-run", "false", "--confirm", "true", "--expected-revision", ""
    ]);
    expect(emptyRevisionRejected).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("lowercase SHA-256")
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

  it("dry-runs separate review, daemon, and issue-enrichment control-center settings", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "control-center-patch.json");
    const invalidPatchPath = join(root, "invalid-control-center-patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/review-repo"],
      pollIntervalMs: 90_000,
      skipDrafts: true,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(patchPath, {
      pollIntervalMs: 120_000,
      skipDrafts: false,
      reviewConcurrency: {
        maxActiveRuns: 2,
        leaseTtlMs: 600_000
      },
      reviewGate: {
        maxInlineComments: 12
      },
      issueEnrichment: {
        enabled: true,
        postIssueComment: false,
        allowlist: ["owner/issues-repo"],
        maxIssuesPerCycle: 4,
        maxCommentsPerCycle: 1,
        globalMaxIssuesPerCycle: 4,
        globalMaxCommentsPerCycle: 1,
        maxActiveRuns: 1,
        leaseTtlMs: 900_000,
        cooldownMs: 3_600_000,
        burstWindowMs: 3_600_000,
        maxIssuesPerBurst: 8,
        lookbackMs: 600_000,
        processExistingOpenIssuesOnActivation: false
      }
    });
    writeConfig(invalidPatchPath, {
      issueEnrichment: {
        maxIssuesPerCycle: 1,
        maxCommentsPerCycle: 2
      }
    });

    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);
    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      wrote: false,
      changedPaths: expect.arrayContaining([
        "pollIntervalMs",
        "skipDrafts",
        "reviewConcurrency.maxActiveRuns",
        "reviewConcurrency.leaseTtlMs",
        "reviewGate.maxInlineComments",
        "issueEnrichment.enabled",
        "issueEnrichment.postIssueComment",
        "issueEnrichment.allowlist",
        "issueEnrichment.maxIssuesPerCycle",
        "issueEnrichment.maxCommentsPerCycle"
      ])
    });
    expect(output.config.pilotRepos).toEqual(["owner/review-repo"]);
    expect(output.config.issueEnrichment.allowlist).toEqual(["owner/issues-repo"]);
    expect(output.changedPaths).not.toContain("pilotRepos");

    const inspected = await runConfig(["config", "inspect", "--config", configPath]);
    expect(inspected.revision).toMatch(/^[a-f0-9]{64}$/);
    const previewed = await runConfig([
      "config", "patch", "--config", configPath, "--input", patchPath,
      "--expected-revision", inspected.revision
    ]);
    expect(previewed).toMatchObject({
      ok: true,
      revisionBefore: inspected.revision,
      revisionAfter: inspected.revision
    });
    writeConfig(configPath, {
      pilotRepos: ["owner/review-repo"],
      pollIntervalMs: 95_000,
      skipDrafts: true,
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    const drifted = await runConfig([
      "config", "patch", "--config", configPath, "--input", patchPath,
      "--dry-run", "false", "--confirm", "true",
      "--expected-revision", inspected.revision
    ]);
    expect(drifted).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("changed since preview")
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).pollIntervalMs).toBe(95_000);

    expect(await runConfig(["config", "patch", "--config", configPath, "--input", invalidPatchPath])).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("maxCommentsPerCycle must be <=")
    });
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
      workRoot: "/tmp/not-desktop-safe"
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

  it("allows desktop patches to set the public GitHub App client id", async () => {
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
      github: { clientId: "Iv1.publicclientid123" }
    });

    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      wrote: false,
      changedPaths: ["github.clientId"]
    });
    expect(output.config.github.clientId).toBe("Iv1.publicclientid123");
  });

  it("dry-runs repo allowlist selector patches and rejects invalid repo names", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "repo-selector-patch.json");
    const invalidPatchPath = join(root, "invalid-repo-selector-patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/existing"],
      issueEnrichment: { allowlist: ["owner/issues-only"] },
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    });
    writeConfig(patchPath, {
      pilotRepos: ["owner/existing", "owner/next-repo"]
    });
    writeConfig(invalidPatchPath, {
      pilotRepos: ["owner/repo/extra"]
    });

    const before = readFileSync(configPath, "utf8");
    const output = await runConfig(["config", "patch", "--config", configPath, "--input", patchPath]);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      wrote: false,
      changedPaths: ["pilotRepos"]
    });
    expect(output.config.pilotRepos).toEqual(["owner/existing", "owner/next-repo"]);
    expect(output.config.issueEnrichment.allowlist).toEqual(["owner/issues-only"]);
    expect(output.changedPaths).not.toContain("issueEnrichment.allowlist");
    expect(readFileSync(configPath, "utf8")).toBe(before);

    const rejected = await runConfig(["config", "patch", "--config", configPath, "--input", invalidPatchPath]);
    expect(rejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("config.pilotRepos entries must be GitHub owner/repo names")
    });
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

  it("reports a committed write truthfully without post-rename metadata I/O", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      desktop: { updateChannel: "dev" }
    });
    writeConfig(patchPath, { desktop: { updateChannel: "beta" } });
    let committed = false;
    const injectedStatSync = ((path: Parameters<typeof statSync>[0], options?: unknown) => {
      if (committed && String(path) === configPath) {
        throw new Error("post-commit config metadata unavailable");
      }
      return statSync(path, options as never);
    }) as unknown as typeof statSync;

    const output = patchConfigForDesktop({
      configPath,
      inputPath: patchPath,
      dryRun: false,
      confirm: true,
      fileOps: {
        statSync: injectedStatSync,
        renameSync: (from, to) => {
          renameSync(from, to);
          committed = true;
        }
      }
    });

    expect(output).toMatchObject({
      ok: true,
      wrote: true,
      revisionAfter: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).desktop.updateChannel).toBe("beta");
  });

  it("preserves committed-write truth when owned lock cleanup fails", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      desktop: { updateChannel: "dev" }
    });
    writeConfig(patchPath, { desktop: { updateChannel: "beta" } });
    const lockPath = `${realpathSync(configPath)}.neondiff.lock`;
    const output = patchConfigForDesktop({
      configPath,
      inputPath: patchPath,
      dryRun: false,
      confirm: true,
      fileOps: {
        renameSync: (from, to) => {
          renameSync(from, to);
        },
        unlinkSync: (path) => {
          if (String(path) === lockPath) throw new Error("forced lock cleanup failure");
          unlinkSync(path);
        }
      }
    });

    expect(output).toMatchObject({
      ok: true,
      wrote: true,
      revisionAfter: expect.stringMatching(/^[a-f0-9]{64}$/),
      warning: expect.stringContaining(lockPath)
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).desktop.updateChannel).toBe("beta");
    unlinkSync(lockPath);

    writeConfig(patchPath, {});
    const failedOutput = patchConfigForDesktop({
      configPath,
      inputPath: patchPath,
      dryRun: false,
      confirm: true,
      fileOps: {
        unlinkSync: (path) => {
          if (String(path) === lockPath) throw new Error("forced lock cleanup failure");
          unlinkSync(path);
        }
      }
    });
    expect(failedOutput).toMatchObject({
      ok: false,
      wrote: false,
      error: "patch input did not contain any leaf settings",
      warning: expect.stringContaining("config patch failed, and failed to release owned lock")
    });
    unlinkSync(lockPath);
  });

  it("serializes live config writers and fails closed for every unowned lock state", () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const firstPatchPath = join(root, "first-patch.json");
    const secondPatchPath = join(root, "second-patch.json");
    const lockPath = `${configPath}.neondiff.lock`;
    const aliasDirectory = join(root, "alias");
    symlinkSync(".", aliasDirectory, "dir");
    const aliasConfigPath = join(aliasDirectory, "config.json");
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      desktop: { updateChannel: "dev" }
    });
    writeConfig(firstPatchPath, { desktop: { updateChannel: "beta" } });
    writeConfig(secondPatchPath, { desktop: { updateChannel: "stable" } });
    const writeFixtureLock = (pid: number) => {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ pid, startedAt: "fixture" })}\n`);
      } finally {
        closeSync(fd);
      }
    };
    const failingRealpathSync = (() => {
      throw new Error("forced realpath failure");
    }) as unknown as typeof realpathSync;
    expect(inspectConfigForDesktop(configPath, { realpathSync: failingRealpathSync })).toMatchObject({
      ok: false,
      error: expect.stringContaining("forced realpath failure")
    });
    expect(patchConfigForDesktop({
      configPath,
      inputPath: firstPatchPath,
      dryRun: false,
      confirm: true,
      fileOps: { realpathSync: failingRealpathSync }
    })).toMatchObject({
      ok: false,
      error: expect.stringContaining("failed to resolve config path")
    });

    let competingResult: ReturnType<typeof patchConfigForDesktop> | undefined;
    const firstResult = patchConfigForDesktop({
      configPath: aliasConfigPath,
      inputPath: firstPatchPath,
      dryRun: false,
      confirm: true,
      fileOps: {
        renameSync: (from, to) => {
          competingResult = patchConfigForDesktop({
            configPath,
            inputPath: secondPatchPath,
            dryRun: false,
            confirm: true
          });
          renameSync(from, to);
        }
      }
    });

    expect(firstResult).toMatchObject({ ok: true, wrote: true });
    expect(competingResult).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("another config patch is running")
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).desktop.updateChannel).toBe("beta");
    expect(existsSync(lockPath)).toBe(false);

    writeFixtureLock(process.pid);
    const staleTime = new Date(Date.now() - 10 * 60 * 1_000);
    utimesSync(lockPath, staleTime, staleTime);
    const liveOwnerRejected = patchConfigForDesktop({
      configPath,
      inputPath: secondPatchPath,
      dryRun: false,
      confirm: true
    });
    expect(liveOwnerRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining(`records PID ${process.pid}, which is currently in use`)
    });

    unlinkSync(lockPath);
    writeFixtureLock(Number.NaN);
    utimesSync(lockPath, staleTime, staleTime);
    const invalidOwnerRejected = patchConfigForDesktop({
      configPath,
      inputPath: secondPatchPath,
      dryRun: false,
      confirm: true
    });
    expect(invalidOwnerRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("stale, corrupt, or owned by an unavailable process")
    });

    unlinkSync(lockPath);
    writeFixtureLock(2_147_483_647);
    const freshDeadOwnerRejected = patchConfigForDesktop({
      configPath,
      inputPath: secondPatchPath,
      dryRun: false,
      confirm: true
    });
    expect(freshDeadOwnerRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("verify no NeonDiff config patch is running")
    });
    utimesSync(lockPath, staleTime, staleTime);
    const staleDeadOwnerRejected = patchConfigForDesktop({
      configPath,
      inputPath: secondPatchPath,
      dryRun: false,
      confirm: true
    });
    expect(staleDeadOwnerRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining(lockPath)
    });

    const existingLockOpenSync = (() => {
      throw Object.assign(new Error("fixture lock already exists"), { code: "EEXIST" });
    }) as typeof openSync;
    const emptyLockReadFileSync = ((path: Parameters<typeof readFileSync>[0], options?: unknown) => (
      path === lockPath ? "" : readFileSync(path, options as never)
    )) as typeof readFileSync;
    const emptyLockRejected = patchConfigForDesktop({
      configPath,
      inputPath: secondPatchPath,
      dryRun: false,
      confirm: true,
      fileOps: {
        openSync: existingLockOpenSync,
        readFileSync: emptyLockReadFileSync
      }
    });
    expect(emptyLockRejected).toMatchObject({
      ok: false,
      error: expect.stringContaining("then remove this lock and retry")
    });

    unlinkSync(lockPath);
    const recovered = patchConfigForDesktop({
      configPath,
      inputPath: secondPatchPath,
      dryRun: false,
      confirm: true
    });
    expect(recovered).toMatchObject({ ok: true, wrote: true });
    expect(JSON.parse(readFileSync(configPath, "utf8")).desktop.updateChannel).toBe("stable");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects a separate CLI process while a live owner holds the config lock", async () => {
    const root = mkRoot();
    const configPath = join(root, "config.json");
    const patchPath = join(root, "patch.json");
    const lockPath = `${configPath}.neondiff.lock`;
    writeConfig(configPath, {
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      desktop: { updateChannel: "dev" }
    });
    writeConfig(patchPath, { desktop: { updateChannel: "beta" } });
    const fd = openSync(lockPath, "wx", 0o600);
    try {
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: "fixture" })}\n`);
    } finally {
      closeSync(fd);
    }

    const result = await runConfig([
      "config", "patch", "--config", configPath, "--input", patchPath,
      "--dry-run", "false", "--confirm", "true"
    ]);

    expect(result).toMatchObject({
      ok: false,
      wrote: false,
      error: expect.stringContaining("another config patch is running")
    });
    expect(JSON.parse(readFileSync(configPath, "utf8")).desktop.updateChannel).toBe("dev");
    unlinkSync(lockPath);
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
      NEONDIFF_GITHUB_APP_ID,
      NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH,
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
