import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderApiKeyVerificationInput } from "../src/local-dashboard.js";
import { runProvidersVerifyCommand } from "../src/providers-verify-command.js";
import { ReviewStateStore } from "../src/state.js";
import { createTestLicenseAdmission } from "./helpers/license-admission.js";
import {
  runLaunchdControlCommand,
  runLaunchctlPlan,
  type LaunchctlResult,
  type LaunchdControlDependencies
} from "../src/launchd-control.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const repoRoot = process.cwd();
const darwinDaemonEnv = { NEONDIFF_TEST_PLATFORM: "darwin" };
const providerVerificationAdmission = await createTestLicenseAdmission({ operation: "provider_verify" });
const admittedProviderVerification = async () => ({
  ok: true as const,
  admission: providerVerificationAdmission
});

describe("public NeonDiff CLI surface", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("declares the neondiff package binary", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
    const packageLock = JSON.parse(readFileSync("package-lock.json", "utf8"));

    expect(packageJson.bin).toEqual({ neondiff: "dist/src/cli.js" });
    expect(packageLock.packages[""].bin).toEqual({ neondiff: "dist/src/cli.js" });
  });

  it("shows public commands in help output", async () => {
    const { stdout } = await runCli(["help"]);
    const output = JSON.parse(stdout);

    expect(output.licenseBoundary).toMatchObject({
      sourceAvailableCommercial: true,
      activationRequired: expect.stringContaining("live API-backed activation"),
      packageVersion: "1.0.4",
      releaseState:
        "This package reports 1.0.4; verify the matching npm version and GitHub Release before relying on activation enforcement."
    });
    expect(output.licenseBoundary.releaseState).not.toContain("1.0.3");
    expect(output.licenseBoundary.releaseState).not.toContain("staged");

    expect(output.commands.public).toEqual([
      "init",
      "config inspect",
      "config patch",
      "pricing",
      "badge",
      "dashboard",
      "providers list",
      "providers doctor",
      "providers verify",
      "doctor",
      "doctor github",
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
    expect(output.examples).toContain("neondiff pricing");
    expect(output.examples).toContain("neondiff badge --config config.local.json --output docs/badges/precision.json");
    expect(output.examples).toContain("neondiff dashboard --config config.local.json");
    expect(output.examples).toContain("neondiff dashboard --preview-smoke true --config config.local.json --output-dir runtime/dashboard-preview-smoke");
    expect(output.examples).toContain("neondiff providers list --config config.local.json --json");
    expect(output.examples).toContain("neondiff providers doctor --config config.local.json --json");
    expect(output.examples).toContain("neondiff providers doctor --config config.local.json --provider ollama-local --smoke true --json");
    expect(output.examples).toContain("neondiff providers verify --config config.local.json --provider openai-compatible --api-key-stdin true --allow-remote-smoke true --json");
    const providersHelp = JSON.parse((await runCli(["providers", "--help"])).stdout);
    expect(providersHelp.usage.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "--expected-config-revision" })
    ]));
    expect(output.examples).toContain("neondiff doctor github --config config.local.json --json");
    expect(output.examples).toContain("neondiff license status --config config.local.json --json");
    expect(output.examples.some((example: string) => example.includes("--license-key-stdin true"))).toBe(true);
    expect(output.examples.join("\n")).not.toContain("--license-key-env");
    const licenseHelp = JSON.parse((await runCli(["license", "--help"])).stdout);
    expect(licenseHelp.licenseBoundary.activationRequired).toContain("public, private, internal, and unknown");
    expect(licenseHelp.usage.flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "--license-key-stdin" }),
      expect.objectContaining({ name: "--persist-local-state" })
    ]));
    expect(licenseHelp.usage.flags).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "--license-key-env" })
    ]));
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

  it("activates the native Keychain-owned path through bounded stdin without local state", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-native-activation-cli-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    const keyPath = join(root, "license.key");
    const cachePath = join(root, "entitlement.json");
    const key = ["nd", "live", "nativekeychainfixture123"].join("_");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["acme/private"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true,
        apiBaseUrl: "https://neondiff-license.fly.dev",
        cachePath,
        storageBackend: "file",
        keyPath
      }
    })}\n`);

    const result = await runCliWithStdin([
      "license",
      "activate",
      "--config",
      configPath,
      "--license-storage",
      "keychain",
      "--license-key-stdin",
      "true",
      "--persist-local-state",
      "false",
      "--json"
    ], `${key}\n`, { env: activatedLicenseTestEnv() });
    const output = JSON.parse(result.stdout);

    expect(output).toMatchObject({
      ok: true,
      status: "active",
      source: "api",
      detail: "license activated without local key or cache persistence"
    });
    expect(result.stdout).not.toContain(key);
    expect(result.stderr).not.toContain(key);
    expect(existsSync(keyPath)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("redacts secret-like values from structured status JSON stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-cli-status-"));
    roots.push(root);
    const secretSegment = "config-secret-value";
    const configPath = join(root, secretSegment, "config.json");
    const statePath = join(root, "state.sqlite");
    const workRoot = join(root, "work");
    const evidenceDir = join(root, "evidence");
    const fakeGithubToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      workRoot,
      statePath,
      evidenceDir,
      github: {
        token: fakeGithubToken
      }
    }));

    let failure: unknown;
    try {
      await runCli([
        "daemon",
        "status",
        "--config",
        configPath,
        "--state-path",
        statePath,
        "--launchd-label",
        "com.example.neondiff"
      ], { env: darwinDaemonEnv });
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ stdout: expect.any(String) });
    const stdout = (failure as { stdout: string }).stdout;
    const output = JSON.parse(stdout);

    expect(output.status.releaseUnit.configPath).toContain("[redacted-secret]");
    expect(stdout).not.toContain(secretSegment);
    expect(stdout).not.toContain(fakeGithubToken);
  });

  it("redacts gitnexus context packet JSON stdout for markdown and both formats", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-gitnexus-cli-"));
    roots.push(root);
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    const fakeToken = ["ghp", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const binDir = join(root, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "gitnexus"), `#!/bin/sh
	if [ "$1" = "list" ]; then
	  if [ "$GITNEXUS_SECRET_MODE" = "1" ]; then
	    index_path="/repos/${fakeToken}/acme-demo"
	  else
	    index_path="/repos/acme-demo"
	  fi
	  printf '%s\\n' "Indexed Repositories" "  acme-demo" "    Path: $index_path" "    Indexed: 2026-07-05T00:00:00Z" "    Commit: ${baseSha}"
	  exit 0
	fi
	if [ "$1" = "query" ]; then
	  echo "safe related context"
	  exit 0
	fi
echo "unexpected gitnexus args: $*" >&2
exit 1
`, { mode: 0o755 });

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/pulls/7") {
        response.end(JSON.stringify({
          number: 7,
          title: "Review GitNexus CLI output",
          draft: false,
          body: "",
          html_url: "https://github.com/acme/demo/pull/7",
          requested_reviewers: [],
          head: {
            sha: headSha,
            ref: "feature/gitnexus",
            repo: { full_name: "acme/demo" }
          },
          base: {
            sha: baseSha,
            ref: "main",
            repo: { full_name: "acme/demo" }
          }
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/pulls/7/files") {
        response.end(JSON.stringify([
          {
            filename: "src/index.ts",
            status: "modified",
            additions: 2,
            deletions: 1,
            changes: 3
          }
        ]));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `unexpected ${request.method} ${url.pathname}` }));
    });

    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, JSON.stringify({
        workRoot: join(root, "work"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        github: {
          token: fakeToken,
          apiBaseUrl: `http://127.0.0.1:${address.port}`
        },
        license: activatedLicenseTestConfig(root),
        gitnexusContext: {
          enabled: true,
          packetVersion: "gitnexus-context-packet-v0.1",
          maxPacketBytes: 40_000,
          maxRelatedItems: 1,
          queryLimit: 1,
          commandTimeoutMs: 1_000,
          maxCommandOutputBytes: 1_000,
          includeStaleContext: false,
          repoAliases: { "acme/demo": "acme-demo" },
          generatedPathPatterns: []
        }
      }));
      const env = { PATH: `${binDir}:${process.env.PATH ?? ""}`, ...activatedLicenseTestEnv() };
      let markdownFailure: unknown;
      try {
        await runCli([
          "build-gitnexus-context-packet",
          "--config",
          configPath,
          "--repo",
          "acme/demo",
          "--pr",
          "7",
          "--format",
          "markdown",
          "--generated-at",
          "2026-07-05T00:00:00.000Z"
        ], { env: { ...env, GITNEXUS_SECRET_MODE: "1" } });
      } catch (error) {
        markdownFailure = error;
      }

      expect(markdownFailure).toMatchObject({ stdout: expect.any(String) });
      const markdownOutput = JSON.parse((markdownFailure as { stdout: string }).stdout);
      expect(markdownOutput.ok).toBe(false);
      expect((markdownFailure as { stdout: string }).stdout).toContain("[redacted-secret]");
      expect((markdownFailure as { stdout: string }).stdout).not.toContain(fakeToken);

      const { stdout } = await runCli([
        "build-gitnexus-context-packet",
        "--config",
        configPath,
        "--repo",
        "acme/demo",
        "--pr",
        "7",
        "--format",
        "both",
        "--generated-at",
        "2026-07-05T00:00:00.000Z"
      ], { env });
      const [jsonPart, markdownPart] = stdout.split("\n\n# GitNexus context packet");
      expect(JSON.parse(jsonPart!).ok).toBe(true);
      expect(markdownPart).toContain("Repository: acme/demo");
      expect(stdout).not.toContain(fakeToken);

      const markdownSuccess = await runCli([
        "build-gitnexus-context-packet",
        "--config",
        configPath,
        "--repo",
        "acme/demo",
        "--pr",
        "7",
        "--format",
        "markdown",
        "--generated-at",
        "2026-07-05T00:00:00.000Z"
      ], { env });
      expect(markdownSuccess.stdout).toContain("# GitNexus context packet");
      expect(markdownSuccess.stdout).not.toContain(fakeToken);
    } finally {
      await closeServer(server);
    }
  });

  it("prints finishing-touch dry-run output as a default-off draft-only contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-finishing-touch-license-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ license: activatedLicenseTestConfig(root) }));
    const { stdout } = await runCli([
      "finishing-touch-dry-run",
      "--config",
      configPath,
      "--repo",
      "electricsheephq/evaos-code-review-bot",
      "--pr",
      "120",
      "--head-sha",
      "0123456789abcdef0123456789abcdef01234567",
      "--current-head",
      "0123456789abcdef0123456789abcdef01234567",
      "--comment-id",
      "789",
      "--author",
      "100yenadmin",
      "--trusted-authors",
      "100yenadmin",
      "--body",
      "@neondiff changelog draft",
      "--generated-at",
      "2026-07-03T00:00:00.000Z"
    ], { env: activatedLicenseTestEnv() });
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      dryRun: true,
      recorded: false,
      contract: {
        ok: true,
        mode: "draft_only",
        defaultOff: true,
        dryRun: true,
        recorded: false,
        target: {
          repo: "electricsheephq/evaos-code-review-bot",
          pullNumber: 120,
          headSha: "0123456789abcdef0123456789abcdef01234567",
          currentHeadSha: "0123456789abcdef0123456789abcdef01234567",
          staleHead: false
        },
        safety: {
          trustedAuthor: true,
          currentHeadMatches: true,
          worktreeClean: "assumed_clean",
          secretScan: "passed",
          mutation: {
            canPush: false,
            canCommit: false,
            canApprove: false,
            directProtectedBranchCommit: false
          }
        }
      }
    });
    expect(output.contract.draft).toMatchObject({
      mode: "draft_only",
      action: "changelog_draft",
      canPush: false,
      canCommit: false,
      canApprove: false
    });
  });

  it("omits failed finishing-touch drafts and secret-bearing triggers from CLI stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-finishing-touch-redaction-license-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ license: activatedLicenseTestConfig(root) }));
    const secretLikeToken = "ghp_fake_token";
    let failure: unknown;
    try {
      await runCli([
        "finishing-touch-dry-run",
        "--config",
        configPath,
        "--repo",
        "electricsheephq/evaos-code-review-bot",
        "--pr",
        "120",
        "--head-sha",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--current-head",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--comment-id",
        "789",
        "--author",
        "100yenadmin",
        "--trusted-authors",
        "100yenadmin",
        "--action",
        "changelog_draft",
        "--body",
        `@evaos-code-review-bot changelog draft ${secretLikeToken}`,
        "--generated-at",
        "2026-07-03T00:00:00.000Z"
      ], { env: activatedLicenseTestEnv() });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ stdout: expect.any(String) });
    const stdout = (failure as { stdout: string }).stdout;
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: false,
      dryRun: true,
      validation: {
        ok: false,
        reason: "secret_detected"
      },
      contract: {
        ok: false,
        command: {
          action: "changelog_draft",
          author: "100yenadmin",
          commentId: 789
        },
        safety: {
          worktreeClean: "assumed_clean",
          secretScan: "failed"
        }
      }
    });
    expect(output.contract).not.toHaveProperty("draft");
    expect(output.contract).not.toHaveProperty("command.trigger");
    expect(stdout).not.toContain(secretLikeToken);
  });

  it("prints canonical pricing tiers without hosted model credit claims", async () => {
    const { stdout } = await runCli(["pricing"]);
    const output = JSON.parse(stdout);

    expect(output).toMatchObject({
      ok: true,
      command: "pricing",
      product: "NeonDiff",
      currency: "USD",
      publicOpenSourceReposFree: false,
      activationRequiredForSupportedReview: true,
      providerCosts: {
        model: "BYOK or local provider",
        includedHostedModelCredits: false
      },
      entitlementShape: {
        paidSupport: {
          repoVisibilityScope: "private",
          requiresPaidLicense: true,
          commercialUse: true,
          autoUpdates: true,
          activeCheckoutPlanIds: ["monthly_support", "yearly_support", "org_yearly_support"],
          legacyAcceptedPlanIds: ["lifetime_support"],
          acceptedPlanIds: ["monthly_support", "yearly_support", "org_yearly_support", "lifetime_support"],
          checkoutLookupKeys: ["neondiff_monthly", "neondiff_yearly", "neondiff_org_yearly"],
          trialDays: {
            individual: 7,
            organization: 30
          }
        }
      }
    });
    expect(output.plans).toEqual([
      expect.objectContaining({
        id: "monthly_support",
        displayPrice: "$1/mo",
        availableForNewPurchase: true,
        trialDays: 7,
        checkoutLookupKey: "neondiff_monthly",
        requiresPaidLicense: true,
        commercialUse: true,
        autoUpdates: true,
        providerCreditsIncluded: false
      }),
      expect.objectContaining({
        id: "yearly_support",
        displayPrice: "$10/yr",
        availableForNewPurchase: true,
        trialDays: 7,
        checkoutLookupKey: "neondiff_yearly",
        requiresPaidLicense: true,
        commercialUse: true,
        autoUpdates: true,
        providerCreditsIncluded: false
      }),
      expect.objectContaining({
        id: "org_yearly_support",
        displayPrice: "$100/yr",
        availableForNewPurchase: true,
        trialDays: 30,
        checkoutLookupKey: "neondiff_org_yearly",
        requiresPaidLicense: true,
        commercialUse: true,
        autoUpdates: true,
        providerCreditsIncluded: false
      }),
      expect.objectContaining({
        id: "lifetime_support",
        displayPrice: "legacy; no longer sold",
        availableForNewPurchase: false,
        legacyNote: expect.stringMatching(/existing lifetime/i),
        requiresPaidLicense: true,
        commercialUse: true,
        autoUpdates: true,
        providerCreditsIncluded: false
      })
    ]);
    expect(stdout).toContain("does not include hosted model credits");
    expect(stdout).not.toMatch(/"includedHostedModelCredits":\s*true|bundled provider tokens included/i);
  });

  it("lists and doctors providers without hiding env-var names or printing keys", async () => {
    const list = JSON.parse((await runCli(["providers", "list"])).stdout);
    const doctor = JSON.parse((await runCli(["providers", "doctor"])).stdout);

    expect(list).toMatchObject({
      ok: true,
      command: "providers list",
      defaultProviderId: "zcode-glm"
    });
    expect(list.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "openai-compatible",
        authMode: "api-key-env",
        apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY"
      }),
      expect.objectContaining({
        id: "ollama-local",
        adapter: "openai-compatible"
      })
    ]));
    expect(JSON.stringify(list)).not.toMatch(/sk-[A-Za-z0-9]|provider-secret/i);

    expect(doctor).toMatchObject({
      ok: true,
      command: "providers doctor",
      defaultProviderId: "zcode-glm",
      checks: [
        expect.objectContaining({
          providerId: "zcode-glm",
          ok: true,
          readMode: "metadata_only"
        })
      ]
    });
  });

  it("blocks providers doctor smoke before contacting a configured endpoint without activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-cli-"));
    roots.push(root);
    let providerRequests = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      providerRequests += 1;
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "local-review-model" }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `unexpected ${request.method} ${url.pathname}` }));
    });
    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        providers: {
          defaultProviderId: "ollama-local",
          providers: {
            "ollama-local": {
              enabled: true,
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              model: "local-review-model",
              authMode: "none"
            }
          }
        }
      })}\n`);

      const result = await runCli([
        "providers",
        "doctor",
        "--config",
        configPath,
        "--provider",
        "ollama-local",
        "--smoke",
        "true"
      ]).then(
        () => { throw new Error("providers doctor smoke unexpectedly succeeded without activation"); },
        (error: unknown) => error as { stdout: string; stderr: string }
      );
      const output = JSON.parse(result.stdout);

      expect(output).toMatchObject({
        ok: false,
        command: "providers doctor",
        error: expect.stringContaining("license missing")
      });
      expect(providerRequests).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("blocks provider-key stdin and provider network before activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-verify-cli-"));
    roots.push(root);
    const fixtureSecret = "fixture-provider-value";
    let providerRequests = 0;
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      providerRequests += 1;
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (
        request.method === "GET" &&
        url.pathname === "/v1/models" &&
        request.headers.authorization === `Bearer ${fixtureSecret}`
      ) {
        response.end(JSON.stringify({ data: [{ id: "fixture-review-model" }] }));
        return;
      }
      response.statusCode = 401;
      response.end(JSON.stringify({ message: "unauthorized" }));
    });
    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        providers: {
          defaultProviderId: "fixture-openai",
          providers: {
            "fixture-openai": {
              enabled: true,
              adapter: "openai-compatible",
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              model: "fixture-review-model",
              authMode: "api-key-env",
              apiKeyEnv: "FIXTURE_PROVIDER_API_KEY",
              capabilities: {
                review: true,
                jsonOutput: true,
                local: true,
                streaming: false
              }
            }
          }
        }
      })}\n`);

      const result = await runCliWithStdin([
        "providers",
        "verify",
        "--config",
        configPath,
        "--provider",
        "fixture-openai",
        "--api-key-stdin",
        "true"
      ], `${fixtureSecret}\n`).then(
        () => { throw new Error("providers verify unexpectedly succeeded without activation"); },
        (error: unknown) => error as { stdout: string; stderr: string }
      );
      const output = JSON.parse(result.stdout);

      expect(output).toMatchObject({
        ok: false,
        command: "providers verify",
        error: expect.stringContaining("license missing")
      });
      expect(JSON.stringify(output)).not.toContain(fixtureSecret);
      expect(result.stdout).not.toContain(fixtureSecret);
      expect(result.stderr).not.toContain(fixtureSecret);
      expect(providerRequests).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("blocks run-once before the first GitHub request without activation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-run-once-license-cli-"));
    roots.push(root);
    let githubRequests = 0;
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      githubRequests += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify([]));
    });
    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        github: {
          token: "fixture-github-token",
          apiBaseUrl: `http://127.0.0.1:${address.port}`
        }
      })}\n`);

      const result = await runCli([
        "run-once",
        "--config",
        configPath,
        "--repo",
        "acme/demo"
      ]).then(
        () => { throw new Error("run-once unexpectedly succeeded without activation"); },
        (error: unknown) => error as { stdout: string; stderr: string }
      );

      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        command: "run-once",
        error: { message: expect.stringContaining("license missing") }
      });
      expect(githubRequests).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("applies default-deny admission to useful commands without scoped help metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-default-deny-cli-"));
    roots.push(root);
    let githubRequests = 0;
    const server = createServer((_request: IncomingMessage, response: ServerResponse) => {
      githubRequests += 1;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({}));
    });
    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        github: {
          token: "fixture-github-token",
          apiBaseUrl: `http://127.0.0.1:${address.port}`
        }
      })}\n`);

      const result = await runCli([
        "build-github-related-context-packet",
        "--config", configPath,
        "--repo", "acme/demo",
        "--pr", "1",
        "--output-dir", join(root, "packet")
      ]).then(
        () => { throw new Error("context packet unexpectedly bypassed activation"); },
        (error: unknown) => error as { stdout: string; stderr: string }
      );

      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("license missing");

      for (const coverageArgs of [
        ["status", "--config", configPath],
        ["runtime-inventory", "--config", configPath],
        ["queue", "--config", configPath],
        ["why", "--repo", "acme/demo", "--pr", "1", "--config", configPath],
        ["dashboard", "--operator", "true", "--config", configPath],
        ["release-status", "--coverage", "true", "--config", configPath]
      ]) {
        const blocked = await runCli(coverageArgs).then(
          () => { throw new Error(`${coverageArgs[0]} unexpectedly bypassed activation`); },
          (error: unknown) => error as { stdout: string; stderr: string }
        );
        expect(blocked.stdout).toBe("");
        expect(blocked.stderr).toContain("license missing");
        expect(githubRequests).toBe(0);
      }
      expect(githubRequests).toBe(0);
    } finally {
      await closeServer(server);
    }
  });

  it("requires the providers verify stdin flag to be present and true", async () => {
    await expect(runCli([
      "providers",
      "verify",
      "--provider",
      "openai-compatible"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("providers verify requires --api-key-stdin true"),
      stderr: ""
    });

    await expect(runCli([
      "providers",
      "verify",
      "--provider",
      "openai-compatible",
      "--api-key-stdin",
      "false"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("providers verify requires --api-key-stdin true"),
      stderr: ""
    });
  });

  it("returns a redacted JSON envelope for malformed verification revisions", async () => {
    await expect(runCli([
      "providers",
      "verify",
      "--config",
      "config.example.json",
      "--provider",
      "openai-compatible",
      "--api-key-stdin",
      "true",
      "--expected-config-revision",
      "not-a-revision"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("expected-config-revision must be a lowercase SHA-256 value"),
      stderr: ""
    });
  });

  it("denies providers verify before waiting on an open stdin pipe", async () => {
    const startedAt = Date.now();
    const result = await runCliWithOpenStdin([
      "providers",
      "verify",
      "--provider",
      "openai-compatible",
      "--api-key-stdin",
      "true",
      "--allow-remote-smoke",
      "true"
    ], "partial-fixture-provider-value");

    expect(result.error).toBeTruthy();
    expect(result.stdout).toContain("license missing");
    expect(result.stdout).not.toContain("partial-fixture-provider-value");
    expect(result.stderr).not.toContain("partial-fixture-provider-value");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.error?.killed).not.toBe(true);
  }, 10_000);

  it("wires explicit hosted remote-smoke consent to a healthy exit zero", async () => {
    const fixtureSecret = "fixture-provider-value";
    let verifierInput: ProviderApiKeyVerificationInput | undefined;
    const result = await runProvidersVerifyCommand({
      configPath: undefined,
      providerId: "openai-compatible",
      apiKeyStdin: "true",
      allowRemoteSmoke: "true",
      stdin: Readable.from([`${fixtureSecret}\n`])
    }, {
      loadConfig: () => ({
        providers: {
          defaultProviderId: "openai-compatible",
          providers: {
            "openai-compatible": {
              enabled: true,
              adapter: "openai-compatible",
              baseUrl: "https://gateway.example.test/v1",
              model: "review-model",
              authMode: "api-key-env",
              apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
              capabilities: { review: true, jsonOutput: true, local: false, streaming: false }
            }
          }
        }
      }) as unknown as ReturnType<typeof import("../src/config.js").loadConfig>,
      verifyProviderApiKey: async (input) => {
        verifierInput = input;
        return {
          ok: true,
          command: "providers verify",
          checkedAt: "2026-07-10T00:00:00.000Z",
          providerId: "openai-compatible",
          state: "healthy",
          mode: "openai_compatible_models",
          detail: "Verified hosted provider with a redacted models check.",
          redacted: true,
          keySource: "submitted",
          troubleshooting: []
        };
      },
      requireActiveProductionLicense: admittedProviderVerification
    });

    expect(verifierInput).toMatchObject({
      command: "providers verify",
      providerId: "openai-compatible",
      apiKey: fixtureSecret,
      allowRemoteSmoke: true
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ ok: true, state: "healthy", redacted: true });
    expect(JSON.stringify(result.output)).not.toContain(fixtureSecret);
  });

  it("rejects provider verification revision drift before stdin, config, or provider execution", async () => {
    let stdinReads = 0;
    let configLoads = 0;
    let snapshotLoads = 0;
    let providerCalls = 0;
    const expectedRevision = "a".repeat(64);
    const result = await runProvidersVerifyCommand({
      configPath: "fixture-config.json",
      providerId: "openai-compatible",
      expectedConfigRevision: expectedRevision,
      apiKeyStdin: "true",
      allowRemoteSmoke: "true",
      stdin: Readable.from(["must-not-be-read\n"])
    }, {
      loadConfigAtRevision: () => {
        snapshotLoads += 1;
        return {
          revision: "b".repeat(64),
          config: {} as ReturnType<typeof import("../src/config.js").loadConfig>
        };
      },
      readSecretFromStdin: async () => {
        stdinReads += 1;
        return "must-not-be-read";
      },
      loadConfig: () => {
        configLoads += 1;
        return {} as ReturnType<typeof import("../src/config.js").loadConfig>;
      },
      verifyProviderApiKey: async () => {
        providerCalls += 1;
        throw new Error("provider must not run");
      },
      requireActiveProductionLicense: admittedProviderVerification
    });

    expect(result).toEqual({
      output: {
        ok: false,
        command: "providers verify",
        error: "config revision changed; reload and apply provider settings before verification"
      },
      exitCode: 1
    });
    expect({ stdinReads, configLoads, providerCalls }).toEqual({ stdinReads: 0, configLoads: 0, providerCalls: 0 });
    expect(snapshotLoads).toBe(1);
  });

  it("fails closed when config changes while provider verification is pending", async () => {
    const expectedRevision = "a".repeat(64);
    const changedRevision = "b".repeat(64);
    let releaseVerification!: () => void;
    const verificationGate = new Promise<void>((resolve) => { releaseVerification = resolve; });
    let snapshotLoads = 0;
    const execution = runProvidersVerifyCommand({
      configPath: "fixture-config.json",
      providerId: "openai-compatible",
      expectedConfigRevision: expectedRevision,
      apiKeyStdin: "true",
      allowRemoteSmoke: "true",
      stdin: Readable.from(["fixture-provider-value\n"])
    }, {
      loadConfigAtRevision: () => ({
        revision: snapshotLoads++ === 0 ? expectedRevision : changedRevision,
        config: {
          providers: {
            defaultProviderId: "openai-compatible",
            providers: { "openai-compatible": {} }
          }
        } as unknown as ReturnType<typeof import("../src/config.js").loadConfig>
      }),
      verifyProviderApiKey: async () => {
        await verificationGate;
        return {
          ok: true,
          command: "providers verify",
          checkedAt: "2026-07-10T00:00:00.000Z",
          providerId: "openai-compatible",
          state: "healthy",
          mode: "openai_compatible_models",
          detail: "Verified hosted provider with redacted metadata.",
          redacted: true,
          troubleshooting: []
        };
      },
      requireActiveProductionLicense: admittedProviderVerification
    });
    await Promise.resolve();
    releaseVerification();
    const result = await execution;

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({
      ok: false,
      state: "blocked",
      redacted: true,
      configRevision: changedRevision
    });
    expect(JSON.stringify(result.output)).not.toContain("fixture-provider-value");
    expect(snapshotLoads).toBe(2);
  });

  it("returns the stable config revision with an unchanged healthy verification", async () => {
    const expectedRevision = "c".repeat(64);
    let snapshotLoads = 0;
    const result = await runProvidersVerifyCommand({
      configPath: "fixture-config.json",
      providerId: "openai-compatible",
      expectedConfigRevision: expectedRevision,
      apiKeyStdin: "true",
      allowRemoteSmoke: "true",
      stdin: Readable.from(["fixture-provider-value\n"])
    }, {
      loadConfigAtRevision: () => {
        snapshotLoads += 1;
        return {
          revision: expectedRevision,
          config: {
            providers: {
              defaultProviderId: "openai-compatible",
              providers: { "openai-compatible": {} }
            }
          } as unknown as ReturnType<typeof import("../src/config.js").loadConfig>
        };
      },
      verifyProviderApiKey: async () => ({
        ok: true,
        command: "providers verify",
        checkedAt: "2026-07-10T00:00:00.000Z",
        providerId: "openai-compatible",
        state: "healthy",
        mode: "openai_compatible_models",
        detail: "Verified hosted provider with redacted metadata.",
        redacted: true,
        troubleshooting: []
      }),
      requireActiveProductionLicense: admittedProviderVerification
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ state: "healthy", configRevision: expectedRevision });
    expect(snapshotLoads).toBe(2);
  });

  it("keeps configured-unverified hosted verification non-success", async () => {
    let stdinReads = 0;
    let providerCalls = 0;
    const result = await runProvidersVerifyCommand({
      configPath: undefined,
      providerId: "openai-compatible",
      apiKeyStdin: "true",
      allowRemoteSmoke: "false",
      stdin: Readable.from(["fixture-provider-value\n"])
    }, {
      loadConfig: () => ({ providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            adapter: "openai-compatible",
            authMode: "api-key-env",
            baseUrl: "https://gateway.example.test/v1"
          }
        }
      } }) as unknown as ReturnType<typeof import("../src/config.js").loadConfig>,
      readSecretFromStdin: async () => {
        stdinReads += 1;
        return "must-not-be-read";
      },
      verifyProviderApiKey: async () => {
        providerCalls += 1;
        throw new Error("provider must not run without consent");
      }
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({ ok: false, state: "configured_unverified", redacted: true });
    expect({ stdinReads, providerCalls }).toEqual({ stdinReads: 0, providerCalls: 0 });
  });

  it("fails hosted remote smoke on activation before considering provider credentials", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-remote-provider-cli-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["acme/demo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            adapter: "openai-compatible",
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model",
            authMode: "api-key-env",
            apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
            capabilities: {
              review: true,
              jsonOutput: true,
              local: false,
              streaming: false
            }
          }
        }
      }
    })}\n`);

    await expect(runCli([
      "providers",
      "doctor",
      "--config",
      configPath,
      "--provider",
      "openai-compatible",
      "--smoke",
      "true"
    ], {
      env: {
        NEONDIFF_PROVIDER_API_KEY: "provider-secret"
      }
    })).rejects.toMatchObject({
      stdout: expect.stringContaining("license missing")
    });
  });

  it("rejects malformed provider ids before reflecting them", async () => {
    const secretLikeProviderId = `sk-${"fixturesecretfixturesecret"}`;
    await expect(runCli(["providers", "doctor", "--provider", secretLikeProviderId])).rejects.toMatchObject({
      stdout: expect.stringContaining("--provider must be a stable provider identifier")
    });
  });

  it("doctor github proves App installation reads without printing secrets", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-doctor-github-"));
    roots.push(root);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const privateKeyPath = join(root, "neondiff.private-key.pem");
    const installationToken = "installation-token-secret";
    writeFileSync(privateKeyPath, privateKeyPem);

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/installation") {
        response.end(JSON.stringify({ id: 42 }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/app/installations/42/access_tokens") {
        response.end(JSON.stringify({ token: installationToken, expires_at: "2099-01-01T00:00:00Z" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/demo") {
        expect(request.headers.authorization).toBe(`Bearer ${installationToken}`);
        response.end(JSON.stringify({ full_name: "acme/demo", private: false, visibility: "public" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/pulls") {
        expect(request.headers.authorization).toBe(`Bearer ${installationToken}`);
        response.end(JSON.stringify([]));
        return;
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/issues") {
        expect(request.headers.authorization).toBe(`Bearer ${installationToken}`);
        expect(url.searchParams.get("state")).toBe("open");
        response.end(JSON.stringify([]));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `unexpected ${request.method} ${url.pathname}` }));
    });

    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        github: {
          appId: "12345",
          privateKeyPath,
          apiBaseUrl: `http://127.0.0.1:${address.port}`
        },
        zcode: {
          cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
          appConfigPath: join(root, "zcode-config.json"),
          model: "GLM-5.2",
          timeoutMs: 1000,
          maxPatchBytes: 1000,
          retryMaxRetries: 0
        },
        issueEnrichment: {
          enabled: true,
          postIssueComment: false,
          allowlist: ["acme/demo"],
          maxIssuesPerCycle: 1,
          maxCommentsPerCycle: 0,
          cooldownMs: 3_600_000,
          burstWindowMs: 3_600_000,
          maxIssuesPerBurst: 3,
          lookbackMs: 600_000,
          processExistingOpenIssuesOnActivation: false
        }
      })}\n`);

      const { stdout } = await runCli(["doctor", "github", "--config", configPath], {
        env: {
          NEONDIFF_GITHUB_APP_ID: "12345",
          NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath
        }
      });
      const output = JSON.parse(stdout);

      expect(output).toMatchObject({
        ok: true,
        command: "doctor github",
        activeRepoChecks: 1,
        appCredentials: {
          appIdConfigured: true,
          privateKeyConfigured: true,
          fallbackTokenConfigured: false
        },
        github: {
          canPostAsApp: true,
          readMode: "app_installation",
          readChecks: [
            {
              repo: "acme/demo",
              ok: true,
              repo_full_name: "acme/demo",
              visibility_result: "public",
              visibility_source: "repository_api",
              installation_id_present: true,
              app_can_read_metadata: true,
              app_can_read_pull_requests: true,
              license_gate_decision: "active_public_entitlement_required",
              pre_checkout_gate_result: "blocked_until_entitlement_proof",
              openPullCount: 0
            }
          ]
        }
      });
      expect(output.issueEnrichment).toMatchObject({
        state: "dry_run_only",
        readChecks: [
          {
            repo: "acme/demo",
            ok: true,
            readableIssueCount: 0
          }
        ]
      });
      expect(output.requiredRepositoryPermissions).toContain("Pull requests: read/write");
      expect(output.optionalPermissions.join(" ")).toMatch(/issue-enrichment/i);
      expect(output.licenseBoundary.privateRepoDataStaysLocal).toBe(true);
      expect(output.github.botLogin).toBe("configured GitHub App bot");
      expect(stdout).not.toContain(privateKeyPem);
      expect(stdout).not.toContain(privateKeyPath);
      expect(stdout).not.toContain(installationToken);
    } finally {
      await closeServer(server);
    }
  });

  it("doctor github blocks pre-checkout when public repo PR permission is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-doctor-github-pr-scope-"));
    roots.push(root);
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPath = join(root, "neondiff.private-key.pem");
    writeFileSync(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }).toString());

    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/installation") {
        response.end(JSON.stringify({ id: 42 }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/app/installations/42/access_tokens") {
        response.end(JSON.stringify({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/demo") {
        response.end(JSON.stringify({ full_name: "acme/demo", private: false, visibility: "public" }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/pulls") {
        response.statusCode = 403;
        response.end(JSON.stringify({ message: "Resource not accessible by integration" }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `unexpected ${request.method} ${url.pathname}` }));
    });

    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        github: {
          appId: "12345",
          privateKeyPath,
          apiBaseUrl: `http://127.0.0.1:${address.port}`
        },
        zcode: {
          cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
          appConfigPath: join(root, "zcode-config.json"),
          model: "GLM-5.2",
          timeoutMs: 1000,
          maxPatchBytes: 1000,
          retryMaxRetries: 0
        }
      })}\n`);

      let stdout = "";
      try {
        await runCli(["doctor", "github", "--config", configPath], {
          env: {
            EVAOS_REVIEW_BOT_APP_ID: "12345",
            EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: privateKeyPath
          }
        });
      } catch (error) {
        stdout = (error as { stdout?: string }).stdout ?? "";
      }
      const output = JSON.parse(stdout);
      expect(output.github.readChecks[0]).toMatchObject({
        ok: false,
        visibility_result: "public",
        app_can_read_metadata: true,
        app_can_read_pull_requests: false,
        github_api_error_class: "resource_not_accessible",
        license_gate_decision: "active_public_entitlement_required",
        pre_checkout_gate_result: "blocked_before_checkout"
      });
      expect(output.github.readChecks[0]).not.toHaveProperty("openPullCount");
    } finally {
      await closeServer(server);
    }
  });

  it("doctor github does not treat fallback-token reads as App installation proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-doctor-github-fallback-token-"));
    roots.push(root);
    const fallbackToken = "github-token-secret";
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/repos/acme/demo/pulls") {
        expect(request.headers.authorization).toBe(`Bearer ${fallbackToken}`);
        response.end(JSON.stringify([]));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: `unexpected ${request.method} ${url.pathname}` }));
    });

    await listen(server);
    try {
      const address = server.address() as AddressInfo;
      const configPath = join(root, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        pilotRepos: ["acme/demo"],
        workRoot: join(root, "runtime"),
        statePath: join(root, "state.sqlite"),
        evidenceDir: join(root, "evidence"),
        github: {
          apiBaseUrl: `http://127.0.0.1:${address.port}`
        },
        zcode: {
          cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
          appConfigPath: join(root, "zcode-config.json"),
          model: "GLM-5.2",
          timeoutMs: 1000,
          maxPatchBytes: 1000,
          retryMaxRetries: 0
        }
      })}\n`);

      let stdout = "";
      try {
        await runCli(["doctor", "github", "--config", configPath], {
          env: { GITHUB_TOKEN: fallbackToken }
        });
      } catch (error) {
        stdout = (error as { stdout?: string }).stdout ?? "";
      }
      const output = JSON.parse(stdout);
      expect(output.ok).toBe(false);
      expect(output.github.readMode).toBe("fallback_token");
      expect(output.github.readChecks[0]).toMatchObject({
        ok: false,
        readMode: "fallback_token",
        visibility_result: "unknown",
        installation_id_present: false,
        app_can_read_metadata: false,
        app_can_read_pull_requests: false,
        github_api_error_class: "missing_app_credentials",
        pre_checkout_gate_result: "blocked_before_checkout"
      });
      expect(stdout).not.toContain(fallbackToken);
    } finally {
      await closeServer(server);
    }
  });

  it("doctor github points missing App credentials at NeonDiff env names", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-doctor-github-missing-env-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["acme/demo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence")
    })}\n`);

    let stdout = "";
    try {
      await runCli(["doctor", "github", "--config", configPath]);
    } catch (error) {
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    const output = JSON.parse(stdout);

    expect(output.ok).toBe(false);
    expect(output.github.readMode).toBe("unconfigured");
    expect(output.troubleshooting.join("\n")).toContain("NEONDIFF_GITHUB_APP_ID");
    expect(output.troubleshooting.join("\n")).toContain("NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH");
    expect(output.troubleshooting.join("\n")).not.toContain("Set EVAOS_REVIEW_BOT_APP_ID");
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
      pollIntervalMs: 60_000,
      license: activatedLicenseTestConfig(root)
    })}\n`);

    await expect(runCli([
      "release-status",
      "--config",
      configPath,
      "--verify-public-rollback-refs",
      "yes"
    ], { env: activatedLicenseTestEnv() })).rejects.toMatchObject({
      stderr: expect.stringContaining("--verify-public-rollback-refs must be true or false")
    });
  });

  it("rejects scoped release-status coverage gates", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-release-status-scope-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: [],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      pollIntervalMs: 60_000,
      license: activatedLicenseTestConfig(root)
    })}\n`);

    await expect(runCli([
      "release-status",
      "--config",
      configPath,
      "--require-coverage",
      "true",
      "--repo",
      "owner/repo"
    ], { env: activatedLicenseTestEnv() })).rejects.toMatchObject({
      stderr: expect.stringContaining("release-status does not support --repo/--pr")
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

  it("prints command-scoped usage for a known command's --help instead of only the generic list", async () => {
    const { stdout } = await runCli(["doctor", "--help"]);
    const output = JSON.parse(stdout);

    expect(output.ok).toBe(true);
    expect(output.command).toBe("doctor");
    // Command-scoped usage must be distinguishable from the generic fallback:
    // it names the specific command's own flags/description, not just the
    // full command list every other command's --help would also show.
    expect(output.usage).toBeDefined();
    expect(output.usage.command).toBe("doctor");
    expect(typeof output.usage.description).toBe("string");
    expect(output.usage.description.length).toBeGreaterThan(0);
    expect(Array.isArray(output.usage.flags)).toBe(true);
    expect(output.usage.flags.some((flag: { name: string }) => flag.name === "--config")).toBe(true);
    // Generic list stays present for backward compatibility with existing callers.
    expect(output.commands.existing).toContain("doctor");
  });

  it("prints distinct command-scoped usage per command, not the same generic block reused", async () => {
    const [doctorResult, statusResult] = await Promise.all([
      runCli(["doctor", "--help"]),
      runCli(["status", "--help"])
    ]);
    const doctorOutput = JSON.parse(doctorResult.stdout);
    const statusOutput = JSON.parse(statusResult.stdout);

    expect(doctorOutput.usage.command).toBe("doctor");
    expect(statusOutput.usage.command).toBe("status");
    expect(doctorOutput.usage.description).not.toBe(statusOutput.usage.description);
  });

  it("keeps generic top-level help unscoped when no command is given", async () => {
    const { stdout } = await runCli(["help"]);
    const output = JSON.parse(stdout);

    expect(output.command).toBeUndefined();
    expect(output.usage).toBeUndefined();
  });

  it("falls back to the generic command list for an unrecognized command's --help", async () => {
    const { stdout } = await runCli(["totally-unknown-command", "--help"]);
    const output = JSON.parse(stdout);

    expect(output.ok).toBe(true);
    expect(output.command).toBe("totally-unknown-command");
    expect(output.usage).toBeUndefined();
    expect(output.commands.existing).toContain("doctor");
  });

  it("prints the package.json version and exits 0 for --version", async () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    const { stdout, stderr } = await runCli(["--version"]);

    expect(stdout.trim()).toBe(packageJson.version);
    expect(stderr).toBe("");
  });

  it("prints the package.json version and exits 0 for the -v shorthand", async () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    const { stdout, stderr } = await runCli(["-v"]);

    expect(stdout.trim()).toBe(packageJson.version);
    expect(stderr).toBe("");
  });

  it("does not execute a command's logic when --version is requested standalone", async () => {
    const { stdout } = await runCli(["--version"]);

    expect(stdout).not.toContain("\"dryRun\"");
    expect(stdout).not.toContain("\"reposScanned\"");
  });

  it("still shows the generic command list and exits nonzero for a bare unknown command (regression pin)", async () => {
    await expect(runCli(["totally-unknown-command"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Unknown command: totally-unknown-command")
    });
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
    const fixtureLeakPattern = new RegExp(
      String.raw`ghp_|BEGIN ${"PRIVATE KEY"}|api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{16,}`,
      "i"
    );
    expect(example).not.toMatch(fixtureLeakPattern);
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
    const ghToken = "ghp_fake_token";
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
      },
      license: activatedLicenseTestConfig(root)
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

    await expect(runCli(["queue", "--config", configPath, "--state", "provider_deferred"], {
      env: activatedLicenseTestEnv()
    })).rejects.toMatchObject({
      stdout: expect.stringContaining("\"runtimeOk\": false")
    });

    try {
      await runCli(["queue", "--config", configPath, "--state", "provider_deferred"], {
        env: activatedLicenseTestEnv()
      });
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
      },
      license: activatedLicenseTestConfig(root)
    })}\n`);
    const store = new ReviewStateStore(statePath);
    const fixtureNow = new Date();
    try {
      store.enqueueReviewQueueJob({
        repo: "other/repo",
        pullNumber: 1,
        headSha: "active-head",
        providerId: "GLM-5.2",
        now: new Date(fixtureNow.getTime() - 2_000)
      });
      store.leaseNextReviewQueueJobs({
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        // Issue #195: keep the synthetic active provider lease relative to the process clock.
        leaseTtlMs: 60 * 60_000,
        now: new Date(fixtureNow.getTime() - 1_000)
      });
      const deferred = store.enqueueReviewQueueJob({
        repo: "owner/repo",
        pullNumber: 123,
        headSha: "head-provider-deferred",
        providerId: "GLM-5.2",
        now: new Date(fixtureNow.getTime() - 500)
      }).job;
      store.updateReviewQueueJobState({
        jobId: deferred.jobId,
        state: "provider_deferred",
        nextEligibleAt: new Date(fixtureNow.getTime() - 250).toISOString(),
        lastError: "provider_overloaded",
        now: fixtureNow
      });
    } finally {
      store.close();
    }

    try {
      await runCli(["queue", "--config", configPath, "--state", "provider_deferred"], {
        env: activatedLicenseTestEnv()
      });
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
      },
      license: activatedLicenseTestConfig(root)
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
      await runCli(["queue", "--config", configPath, "--repo", "owner/repo"], {
        env: activatedLicenseTestEnv()
      });
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

  it("builds launchd daemon control plans in dry-run mode by default", () => {
    const launchctl = createLaunchctlHarness({ loaded: true });
    const start = runTestLaunchdControl({ action: "start" }, launchctl.dependencies);
    const stop = runTestLaunchdControl({ action: "stop" }, launchctl.dependencies);

    expect(start).toMatchObject({
      ok: true,
      command: "daemon start",
      dryRun: true,
      launchdLabel: "com.example.neondiff",
      operation: "kickstart_existing",
      plannedCommands: [["launchctl", "kickstart", "-k", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]]
    });
    expect(stop).toMatchObject({
      ok: true,
      command: "daemon stop",
      dryRun: true,
      launchdLabel: "com.example.neondiff",
      operation: "bootout_service",
      plannedCommands: [["launchctl", "bootout", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]]
    });
  });

  it("does not execute a PATH-controlled launchctl during daemon start dry-run", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-path-poison-"));
    roots.push(root);
    const binDir = join(root, "bin");
    const markerPath = join(root, "poisoned-launchctl-ran");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, "launchctl"), `#!/bin/sh
: > "$NEONDIFF_TEST_POISON_MARKER"
exit 113
`, { mode: 0o755 });

    await runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff.path-poison"
    ], {
      env: {
        ...darwinDaemonEnv,
        HOME: root,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        NEONDIFF_TEST_POISON_MARKER: markerPath
      }
    }).catch(() => undefined);

    expect(existsSync(markerPath)).toBe(false);
  });

  it("does not execute a PATH-controlled plutil during plist validation", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-plutil-path-poison-"));
    roots.push(root);
    const launchdLabel = "com.example.neondiff.plutil-path-poison";
    const launchAgentsDir = join(root, "Library", "LaunchAgents");
    const plistPath = join(launchAgentsDir, `${launchdLabel}.plist`);
    const binDir = join(root, "bin");
    const markerPath = join(root, "poisoned-plutil-ran");
    mkdirSync(launchAgentsDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeLaunchdPlist(plistPath, launchdLabel);
    writeFileSync(join(binDir, "plutil"), `#!/bin/sh
: > "$NEONDIFF_TEST_POISON_MARKER"
printf '%s\\n' "$NEONDIFF_TEST_PLUTIL_LABEL"
exit 0
`, { mode: 0o755 });

    const { stdout } = await runCli([
      "daemon",
      "stop",
      "--launchd-label",
      launchdLabel,
      "--plist",
      plistPath
    ], {
      env: {
        ...darwinDaemonEnv,
        HOME: root,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        NEONDIFF_TEST_POISON_MARKER: markerPath,
        NEONDIFF_TEST_PLUTIL_LABEL: launchdLabel
      }
    });

    expect(JSON.parse(stdout)).toMatchObject({
      ok: true,
      command: "daemon stop",
      dryRun: true,
      operation: "bootout_plist",
      plistPath,
      plannedCommands: [["launchctl", "bootout", expect.stringMatching(/^gui\/\d+$/), plistPath]]
    });
    expect(existsSync(markerPath)).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "exercises the golden unloaded start plan through the real CLI boundary",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-cli-plan-"));
      roots.push(root);
      const launchdLabel = `com.example.neondiff.cli-plan.${process.pid}.${Date.now()}`;
      const launchAgentsDir = join(root, "Library", "LaunchAgents");
      const plistPath = join(launchAgentsDir, `${launchdLabel}.plist`);
      mkdirSync(launchAgentsDir, { recursive: true });
      writeLaunchdPlist(plistPath, launchdLabel);

      const { stdout } = await runCli([
        "daemon",
        "start",
        "--launchd-label",
        launchdLabel,
        "--dry-run",
        "true"
      ], { env: { ...darwinDaemonEnv, HOME: root } });

      expect(JSON.parse(stdout)).toMatchObject({
        ok: true,
        command: "daemon start",
        dryRun: true,
        launchdLoaded: false,
        operation: "bootstrap_then_kickstart",
        plistPath,
        plannedCommands: [
          ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath],
          ["launchctl", "kickstart", "-k", expect.stringContaining(launchdLabel)]
        ]
      });
    }
  );

  it("plans bootstrap from the standard plist when the launchd service is not loaded", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-stopped-"));
    roots.push(root);
    const launchAgentsDir = join(root, "Library", "LaunchAgents");
    const plistPath = join(launchAgentsDir, "com.example.neondiff.plist");
    mkdirSync(launchAgentsDir, { recursive: true });
    writeLaunchdPlist(plistPath, "com.example.neondiff");
    const launchctl = createLaunchctlHarness({ loaded: false });
    const output = runTestLaunchdControl({ standardPlistPath: plistPath }, launchctl.dependencies);

    expect(output).toMatchObject({
      ok: true,
      command: "daemon start",
      dryRun: true,
      operation: "bootstrap_then_kickstart",
      plistPath,
      plannedCommands: [
        ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath],
        ["launchctl", "kickstart", "-k", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]
      ]
    });
    expect(launchctl.commands).toEqual([["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)]]);
  });

  it("fails start planning when the service is unloaded and no plist exists", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-missing-plist-"));
    roots.push(root);
    const standardPlistPath = join(root, "Library", "LaunchAgents", "com.example.neondiff.plist");
    const launchctl = createLaunchctlHarness({ loaded: false });

    const output = runTestLaunchdControl({ standardPlistPath }, launchctl.dependencies);

    expect(output).toMatchObject({
      ok: false,
      command: "daemon start",
      dryRun: true,
      launchdLoaded: false,
      error: `launchd service is not loaded and no plist was found; pass --plist or install ${standardPlistPath}`
    });
    expect(output.plannedCommands).toBeUndefined();
    expect(output.operation).toBeUndefined();
    expect(launchctl.commands).toEqual([["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)]]);
  });

  it("plans kickstart only when the launchd service is already loaded", () => {
    const launchctl = createLaunchctlHarness({ loaded: true });
    const output = runTestLaunchdControl({ action: "start" }, launchctl.dependencies);

    expect(output).toMatchObject({
      ok: true,
      command: "daemon start",
      dryRun: true,
      operation: "kickstart_existing",
      plannedCommands: [
        ["launchctl", "kickstart", "-k", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)]
      ]
    });
    expect(launchctl.commands).toEqual([["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)]]);
  });

  it("fails closed when launchctl print cannot classify the service state", () => {
    const launchctl = createLaunchctlHarness({
      loaded: false,
      printFailure: { exitCode: 64, stderr: "Operation not permitted" }
    });

    expect(() => runTestLaunchdControl({ action: "start" }, launchctl.dependencies))
      .toThrow("failed to inspect launchd service");
    expect(launchctl.commands).toEqual([["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)]]);
  });

  it("does not treat exit 113 without a not-found diagnostic as unloaded", () => {
    const launchctl = createLaunchctlHarness({
      loaded: false,
      printFailure: { exitCode: 113, stderr: "Operation not permitted" }
    });

    expect(() => runTestLaunchdControl({ action: "start" }, launchctl.dependencies))
      .toThrow("failed to inspect launchd service");
  });

  it("requires config for daemon status", async () => {
    await expect(runCli([
      "daemon",
      "status",
      "--launchd-label",
      "com.example.neondiff"
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
      stdout: expect.stringContaining("--config is required for daemon status")
    });
  });

  it("degrades launchd daemon controls on Linux with systemd guidance", async () => {
    const startError = await runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff"
    ], { env: { NEONDIFF_TEST_PLATFORM: "linux" } }).catch((error: { stdout: string }) => error);
    const statusError = await runCli([
      "daemon",
      "status"
    ], { env: { NEONDIFF_TEST_PLATFORM: "linux" } }).catch((error: { stdout: string }) => error);

    expect(JSON.parse(startError.stdout)).toMatchObject({
      ok: false,
      command: "daemon start",
      platform: "linux",
      serviceManager: "systemd",
      docs: "docs/systemd.md",
      error: expect.stringContaining("launchd daemon controls are only supported on macOS")
    });
    expect(JSON.parse(startError.stdout).error).toContain("use systemd");
    expect(JSON.parse(startError.stdout).plannedCommands).toBeUndefined();
    expect(JSON.parse(statusError.stdout)).toMatchObject({
      ok: false,
      command: "daemon status",
      platform: "linux",
      serviceManager: "systemd",
      docs: "docs/systemd.md",
      error: expect.stringContaining("use systemd")
    });
  });

  it("degrades launchd daemon controls on non-Linux platforms with Docker guidance", async () => {
    const statusError = await runCli([
      "daemon",
      "status"
    ], { env: { NEONDIFF_TEST_PLATFORM: "win32" } }).catch((error: { stdout: string }) => error);

    const output = JSON.parse(statusError.stdout);
    expect(output).toMatchObject({
      ok: false,
      command: "daemon status",
      platform: "win32",
      docs: "docs/docker.md",
      error: expect.stringContaining("Use Docker")
    });
    expect(output.serviceManager).toBeUndefined();
  });

  it("validates launchd labels and plist labels before planning daemon commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-plist-"));
    roots.push(root);
    const plistPath = join(root, "com.example.neondiff.plist");
    writeLaunchdPlist(plistPath, "com.example.neondiff");
    const launchctl = createLaunchctlHarness({ loaded: false });
    const output = runTestLaunchdControl({ requestedPlistPath: plistPath }, launchctl.dependencies);

    expect(output).toMatchObject({
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
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
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
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
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
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
      stdout: expect.stringContaining("requires --confirm true")
    });
  });

  it("rejects unconfirmed live start before launchctl or plist inspection", () => {
    const calls: string[] = [];
    const output = runTestLaunchdControl({
      dryRun: false,
      confirm: false,
      requestedPlistPath: "/operator/owned/com.example.neondiff.plist"
    }, {
      executeLaunchctl(command) {
        calls.push(`launchctl:${command[1]}`);
        return { command, exitCode: 0 };
      },
      plistExists(path) {
        calls.push(`plist-exists:${path}`);
        return true;
      },
      assertPlistLabelMatches(path) {
        calls.push(`plist-label:${path}`);
      },
      plistWarning(path) {
        calls.push(`plist-warning:${path}`);
        return undefined;
      },
      launchdSessionError() {
        calls.push("launchd-session");
        return undefined;
      }
    });

    expect(output).toMatchObject({
      ok: false,
      command: "daemon start",
      dryRun: false,
      error: "daemon start requires --confirm true when --dry-run false is used"
    });
    expect(calls).toEqual([]);
  });

  it("continues with kickstart when bootstrap races with another loader", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-bootstrap-race-"));
    roots.push(root);
    const plistPath = join(root, "com.example.neondiff.plist");
    writeLaunchdPlist(plistPath, "com.example.neondiff");
    const launchctl = createLaunchctlHarness({ loaded: false, bootstrapRace: true });
    const output = runTestLaunchdControl({
      requestedPlistPath: plistPath,
      dryRun: false,
      confirm: true,
      allowExternalPlist: true
    }, launchctl.dependencies);

    expect(output).toMatchObject({
      ok: true,
      command: "daemon start",
      dryRun: false,
      launchdLoaded: false,
      operation: "bootstrap_then_kickstart",
      results: [
        {
          command: ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath],
          exitCode: 0,
          observedExitCode: 125,
          acceptedAs: "already_loaded"
        },
        {
          command: ["launchctl", "kickstart", "-k", expect.stringMatching(/gui\/\d+\/com\.example\.neondiff/)],
          exitCode: 0
        }
      ]
    });
    expect(launchctl.commands).toEqual([
      ["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)],
      ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath],
      ["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)],
      ["launchctl", "kickstart", "-k", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)]
    ]);
  });

  it("does not mask an unrelated bootstrap failure when a service appears", () => {
    let serviceLoaded = false;
    const commands = [
      ["launchctl", "bootstrap", "gui/501", "/operator/owned/com.example.neondiff.plist"],
      ["launchctl", "kickstart", "-k", "gui/501/com.example.neondiff"]
    ];
    const results = runLaunchctlPlan(commands, (command) => {
      if (command[1] === "bootstrap") {
        serviceLoaded = true;
        return { command, exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error" };
      }
      if (command[1] === "print") {
        return serviceLoaded
          ? { command, exitCode: 0, stdout: "service loaded" }
          : { command, exitCode: 113, stderr: "Could not find service" };
      }
      return { command, exitCode: 0 };
    }, {
      acceptAlreadyLoadedBootstrap: true,
      launchdTarget: "gui/501/com.example.neondiff"
    });

    expect(results).toEqual([
      {
        command: ["launchctl", "bootstrap", "gui/501", "/operator/owned/com.example.neondiff.plist"],
        exitCode: 5,
        stderr: "Bootstrap failed: 5: Input/output error"
      }
    ]);
  });

  it("bootstraps the exact standard LaunchAgent path without an external-plist override", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-standard-live-"));
    roots.push(root);
    const launchAgentsDir = join(root, "Library", "LaunchAgents");
    const plistPath = join(launchAgentsDir, "com.example.neondiff.plist");
    mkdirSync(launchAgentsDir, { recursive: true });
    writeLaunchdPlist(plistPath, "com.example.neondiff");
    const plistBeforeStart = readFileSync(plistPath, "utf8");
    const launchctl = createLaunchctlHarness({ loaded: false });
    const output = runTestLaunchdControl({
      standardPlistPath: plistPath,
      dryRun: false,
      confirm: true
    }, launchctl.dependencies);

    expect(output).toMatchObject({
      ok: true,
      operation: "bootstrap_then_kickstart",
      plistPath,
      results: [
        { command: ["launchctl", "bootstrap", expect.stringMatching(/^gui\/\d+$/), plistPath], exitCode: 0 },
        { command: ["launchctl", "kickstart", "-k", expect.any(String)], exitCode: 0 }
      ]
    });
    expect(output.warning).toBeUndefined();
    expect(readFileSync(plistPath, "utf8")).toBe(plistBeforeStart);
  });

  it("requires an external-plist opt-in before confirmed launchctl mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-launchd-external-opt-in-"));
    roots.push(root);
    const plistPath = join(root, "com.example.neondiff.plist");
    writeLaunchdPlist(plistPath, "com.example.neondiff");
    const launchctl = createLaunchctlHarness({ loaded: false });
    const output = runTestLaunchdControl({
      requestedPlistPath: plistPath,
      dryRun: false,
      confirm: true
    }, launchctl.dependencies);

    expect(output).toMatchObject({
      ok: false,
      error: expect.stringContaining("requires --allow-external-plist true")
    });
    expect(launchctl.commands).toEqual([["launchctl", "print", expect.stringMatching(/^gui\/\d+\/com\.example\.neondiff$/)]]);
  });

  it("requires activation before confirmed live daemon mutation with an external plist", async () => {
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
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
      stderr: expect.stringContaining("license missing")
    });
  });

  it("blocks a confirmed live daemon start with an internal plist before launchctl", async () => {
    await expect(runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff",
      "--plist",
      join(repoRoot, "package.json"),
      "--dry-run",
      "false",
      "--confirm",
      "true"
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
      stderr: expect.stringContaining("license missing")
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
    // The loop dispatches, but useful daemon work remains blocked until activation.
    await expect(runCli([
      "daemon",
      "--config",
      configPath,
      "--dry-run",
      "true",
      "--once",
      "true"
    ])).rejects.toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("license missing")
    });
    await expect(runCli([
      "daemon",
      "--config",
      configPath,
      "--dry-run",
      "true"
    ], { timeout: 5_000 })).rejects.toMatchObject({
      stdout: "",
      stderr: expect.stringContaining("license missing")
    });
  });
});

async function runCli(args: string[], options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}) {
  return execFileAsync(process.execPath, [tsxCliPath, join(repoRoot, "src/cli.ts"), ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NEONDIFF_GITHUB_APP_ID: "",
      NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH: "",
      EVAOS_REVIEW_BOT_APP_ID: "",
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "",
      GITHUB_TOKEN: "",
      ...options.env
    },
    timeout: options.timeout ?? 15_000,
    killSignal: "SIGTERM",
    maxBuffer: 1024 * 1024
  });
}

function activatedLicenseTestConfig(root: string) {
  const keyPath = join(root, "fixture-license.key");
  writeFileSync(keyPath, `${["nd", "live", "fixturepubliccli0123456789"].join("_")}\n`, { mode: 0o600 });
  return {
    enabled: true,
    apiBaseUrl: "https://neondiff-license.fly.dev",
    cachePath: join(root, "fixture-entitlement.json"),
    storageBackend: "file",
    keyPath,
    requestTimeoutMs: 1_000,
    offlineGraceMs: 0,
    publicReposFree: false,
    privateReposRequireEntitlement: true,
    updateEntitlementRequiresLicense: true
  };
}

function activatedLicenseTestEnv(): NodeJS.ProcessEnv {
  return {
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${join(repoRoot, "tests", "helpers", "mock-production-license-api.mjs")}`.trim()
  };
}

function runCliWithStdin(
  args: string[],
  stdin: string,
  options: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [tsxCliPath, join(repoRoot, "src/cli.ts"), ...args], {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NEONDIFF_GITHUB_APP_ID: "",
        NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH: "",
        EVAOS_REVIEW_BOT_APP_ID: "",
        EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "",
        GITHUB_TOKEN: "",
        ...options.env
      },
      timeout: options.timeout ?? 15_000,
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end(stdin);
  });
}

function runCliWithOpenStdin(
  args: string[],
  stdin: string
): Promise<{
  error: (Error & { killed?: boolean; signal?: NodeJS.Signals | null }) | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [tsxCliPath, join(repoRoot, "src/cli.ts"), ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NEONDIFF_GITHUB_APP_ID: "",
        NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH: "",
        EVAOS_REVIEW_BOT_APP_ID: "",
        EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "",
        GITHUB_TOKEN: ""
      },
      timeout: 8_000,
      killSignal: "SIGTERM",
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      child.stdin?.destroy();
      resolve({
        error: error as (Error & { killed?: boolean; signal?: NodeJS.Signals | null }) | null,
        stdout,
        stderr
      });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.write(stdin);
  });
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
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

function runTestLaunchdControl(
  overrides: Partial<Parameters<typeof runLaunchdControlCommand>[0]>,
  dependencies: LaunchdControlDependencies
) {
  const launchdLabel = overrides.launchdLabel ?? "com.example.neondiff";
  const launchdDomain = overrides.launchdDomain ?? `gui/${process.getuid?.() ?? 501}`;
  return runLaunchdControlCommand({
    action: "start",
    dryRun: true,
    confirm: false,
    allowExternalPlist: false,
    launchdLabel,
    launchdDomain,
    launchdTarget: `${launchdDomain}/${launchdLabel}`,
    standardPlistPath: join(tmpdir(), "neondiff-missing-launchagents", `${launchdLabel}.plist`),
    ...overrides
  }, dependencies);
}

function createLaunchctlHarness(options: {
  loaded: boolean;
  bootstrapRace?: boolean;
  printFailure?: Omit<LaunchctlResult, "command">;
}): { commands: string[][]; dependencies: LaunchdControlDependencies } {
  const commands: string[][] = [];
  let loaded = options.loaded;
  const executeLaunchctl = (command: string[]): LaunchctlResult => {
    commands.push(command);
    if (command[1] === "print") {
      if (options.printFailure) return { command, ...options.printFailure };
      return loaded
        ? { command, exitCode: 0, stdout: "service loaded" }
        : { command, exitCode: 113, stderr: "Could not find service" };
    }
    if (command[1] === "bootstrap" && options.bootstrapRace) {
      loaded = true;
      return { command, exitCode: 125, stderr: "Bootstrap failed: 125: Service already bootstrapped" };
    }
    return { command, exitCode: 0 };
  };
  return {
    commands,
    dependencies: {
      executeLaunchctl,
      plistExists: existsSync,
      assertPlistLabelMatches(path, launchdLabel) {
        const xml = readFileSync(path, "utf8");
        const match = xml.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/);
        if (match?.[1] !== launchdLabel) throw new Error("plist label mismatch");
      },
      plistWarning(path) {
        return path === repoRoot || path.startsWith(`${repoRoot}/`)
          ? undefined
          : "--plist is outside the NeonDiff package root; use only operator-owned plist paths";
      },
      launchdSessionError: () => undefined
    }
  };
}
