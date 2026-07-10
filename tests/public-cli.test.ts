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

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const repoRoot = process.cwd();
const darwinDaemonEnv = { NEONDIFF_TEST_PLATFORM: "darwin" };

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
    expect(output.examples).toContain("neondiff providers verify --config config.local.json --provider openai-compatible --api-key-stdin true --json");
    expect(output.examples).toContain("neondiff doctor github --config config.local.json --json");
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
      const env = { PATH: `${binDir}:${process.env.PATH ?? ""}` };
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
    const { stdout } = await runCli([
      "finishing-touch-dry-run",
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
    ]);
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
    const secretLikeToken = "ghp_fake_token";
    let failure: unknown;
    try {
      await runCli([
        "finishing-touch-dry-run",
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
      ]);
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
      publicOpenSourceReposFree: true,
      providerCosts: {
        model: "BYOK or local provider",
        includedHostedModelCredits: false
      },
      entitlementShape: {
        freeOss: {
          repoVisibilityScope: "public",
          requiresPaidLicense: false
        },
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
        id: "free_oss",
        displayPrice: "$0",
        requiresPaidLicense: false,
        providerCreditsIncluded: false
      }),
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

  it("runs providers doctor smoke through the public CLI against a local OpenAI-compatible endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-cli-"));
    roots.push(root);
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
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

      const output = JSON.parse((await runCli([
        "providers",
        "doctor",
        "--config",
        configPath,
        "--provider",
        "ollama-local",
        "--smoke",
        "true"
      ])).stdout);

      expect(output).toMatchObject({
        ok: true,
        command: "providers doctor",
        providerId: "ollama-local",
        checks: [
          expect.objectContaining({
            providerId: "ollama-local",
            ok: true,
            smokeAttempted: true,
            readMode: "openai_compatible_models",
            modelCount: 1
          })
        ]
      });
    } finally {
      await closeServer(server);
    }
  });

  it("verifies a provider key from stdin without serializing the submitted value", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-provider-verify-cli-"));
    roots.push(root);
    const fixtureSecret = "fixture-provider-value";
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
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
      ], `${fixtureSecret}\n`);
      const output = JSON.parse(result.stdout);

      expect(output).toMatchObject({
        ok: true,
        command: "providers verify",
        redacted: true,
        providerId: "fixture-openai",
        state: "healthy",
        mode: "openai_compatible_models"
      });
      expect(JSON.stringify(output)).not.toContain(fixtureSecret);
      expect(result.stdout).not.toContain(fixtureSecret);
      expect(result.stderr).not.toContain(fixtureSecret);
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
      stderr: expect.stringContaining("providers verify requires --api-key-stdin true")
    });

    await expect(runCli([
      "providers",
      "verify",
      "--provider",
      "openai-compatible",
      "--api-key-stdin",
      "false"
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining("providers verify requires --api-key-stdin true")
    });
  });

  it("exits providers verify after the bounded stdin deadline even when the parent keeps the pipe open", async () => {
    const startedAt = Date.now();
    const result = await runCliWithOpenStdin([
      "providers",
      "verify",
      "--provider",
      "openai-compatible",
      "--api-key-stdin",
      "true"
    ], "partial-fixture-provider-value");

    expect(result.error).toBeTruthy();
    expect(result.stderr).toContain("provider secret stdin timed out after 5000ms");
    expect(result.stderr).not.toContain("partial-fixture-provider-value");
    expect(Date.now() - startedAt).toBeLessThan(7_500);
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
      }
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
      }
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
      }
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
      })
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toMatchObject({ state: "healthy", configRevision: expectedRevision });
    expect(snapshotLoads).toBe(2);
  });

  it("keeps configured-unverified hosted verification non-success", async () => {
    const result = await runProvidersVerifyCommand({
      configPath: undefined,
      providerId: "openai-compatible",
      apiKeyStdin: "true",
      allowRemoteSmoke: "false",
      stdin: Readable.from(["fixture-provider-value\n"])
    }, {
      loadConfig: () => ({ providers: { defaultProviderId: "openai-compatible", providers: {} } }) as unknown as ReturnType<typeof import("../src/config.js").loadConfig>,
      verifyProviderApiKey: async () => ({
        ok: false,
        command: "providers verify",
        checkedAt: "2026-07-10T00:00:00.000Z",
        providerId: "openai-compatible",
        state: "configured_unverified",
        mode: "metadata_only",
        detail: "Hosted smoke was not run.",
        redacted: true,
        keySource: "submitted",
        troubleshooting: ["Explicit remote consent is required."]
      })
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toMatchObject({ ok: false, state: "configured_unverified", redacted: true });
  });

  it("fails hosted remote smoke through the public CLI without explicit remote opt-in", async () => {
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
      stdout: expect.stringContaining("Remote OpenAI-compatible smoke checks require explicit remote opt-in and --provider <id>.")
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
              license_gate_decision: "public_free_allowed",
              pre_checkout_gate_result: "allowed",
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
        license_gate_decision: "public_free_allowed",
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

  it("rejects scoped release-status coverage gates", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-release-status-scope-"));
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
      "--require-coverage",
      "true",
      "--repo",
      "owner/repo"
    ])).rejects.toMatchObject({
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
    ], { env: darwinDaemonEnv });
    const { stdout: stopStdout } = await runCli([
      "daemon",
      "stop",
      "--launchd-label",
      "com.example.neondiff"
    ], { env: darwinDaemonEnv });

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

    const { stdout } = await runCli([
      "daemon",
      "start",
      "--launchd-label",
      "com.example.neondiff",
      "--plist",
      plistPath
    ], { env: darwinDaemonEnv });

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
    ], { env: darwinDaemonEnv })).rejects.toMatchObject({
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
