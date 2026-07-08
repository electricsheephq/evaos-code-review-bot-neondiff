import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReleaseStatus,
  collectReleaseStatus,
  parseLaunchdPrintStatus,
  readPublicReleaseManifestStatus,
  validatePublicReleaseManifestInputs
} from "../src/release-status.js";
import type { ReviewBudgetStatus } from "../src/review-budget.js";
import { stringifyRedactedJson } from "../src/secrets.js";
import { ReviewStateStore } from "../src/state.js";

describe("beta release status", () => {
  const roots: string[] = [];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const shippedReleaseValidationNow = new Date("2026-07-08T06:50:00Z");

  afterEach(() => {
    vi.useRealTimers();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function writeLicenseHealthProof(root: string, options: {
    evidenceKind?: string;
    releaseVersion?: string;
    observedAt?: string;
    method?: string;
    url?: string;
    statusCode?: number;
    responseBody?: string;
    responseBodySha256?: string;
    captureContext?: Record<string, unknown>;
    path?: string;
  } = {}): string {
    const proofPath = options.path ?? "docs/evidence/license-healthz.json";
    const responseBody = options.responseBody ?? "{\"status\":\"ok\"}";
    mkdirSync(dirname(join(root, proofPath)), { recursive: true });
    writeFileSync(join(root, proofPath), JSON.stringify({
      evidenceKind: options.evidenceKind ?? "license_api_healthz",
      releaseVersion: options.releaseVersion ?? "v1.0.0-beta.1",
      observedAt: options.observedAt ?? new Date().toISOString(),
      method: options.method ?? "GET",
      url: options.url ?? "https://license.example/healthz",
      statusCode: options.statusCode ?? 200,
      responseBody,
      responseBodySha256: options.responseBodySha256 ?? createHash("sha256").update(responseBody).digest("hex"),
      captureContext: options.captureContext ?? {
        tool: "curl",
        transport: "https",
        tlsValidation: "curl default CA validation",
        capturedFrom: "test runner"
      }
    }));
    return proofPath;
  }

  function writeLicenseIssuanceProof(root: string, options: {
    evidenceKind?: string;
    releaseVersion?: string;
    observedAt?: string;
    method?: string;
    url?: string;
    statusCode?: number;
    responseBody?: string;
    responseBodySha256?: string;
    captureContext?: Record<string, unknown>;
    path?: string;
  } = {}): string {
    const proofPath = options.path ?? "docs/evidence/license-checkout-issuance.json";
    const responseBody = options.responseBody ?? "{\"status\":\"unauthorized\",\"detail\":\"license issuance authorization failed\"}";
    mkdirSync(dirname(join(root, proofPath)), { recursive: true });
    writeFileSync(join(root, proofPath), JSON.stringify({
      evidenceKind: options.evidenceKind ?? "license_api_checkout_issuance",
      releaseVersion: options.releaseVersion ?? "v1.0.0-beta.1",
      observedAt: options.observedAt ?? new Date().toISOString(),
      method: options.method ?? "POST",
      url: options.url ?? "https://license.example/v1/admin/licenses/issue",
      statusCode: options.statusCode ?? 401,
      responseBody,
      responseBodySha256: options.responseBodySha256 ?? createHash("sha256").update(responseBody).digest("hex"),
      captureContext: options.captureContext ?? {
        tool: "curl",
        transport: "https",
        tlsValidation: "curl default CA validation",
        capturedFrom: "test runner"
      }
    }));
    return proofPath;
  }

  function writeChangelogHead(root: string, version = "1.0.0-beta.1", releaseNotesPath = `docs/releases/v${version}.md`): void {
    writeFileSync(join(root, "CHANGELOG.md"), [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "No unreleased changes tracked yet.",
      "",
      `## [${version}] - ${releaseNotesPath}`,
      "",
      "### Added",
      "- Fixture release entry.",
      ""
    ].join("\n"));
  }

  it("fails closed when the live checkout is dirty or not at the expected head", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "actual-head",
        dirtyFiles: ["src/config.ts"]
      },
      expectedHead: "expected-head",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        pid: 123,
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
        dryRun: false
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({ name: "expected_head", ok: false, detail: "actual-head != expected-head" });
    expect(status.gates).toContainEqual({ name: "clean_checkout", ok: false, detail: "1 dirty file(s)" });
    expect(status.rollback.restartCommand).toContain("launchctl kickstart -k");
  });

  it("reports a passing beta release surface without exposing secrets", () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), "release-status-"));
    roots.push(evidenceRoot);
    mkdirSync(join(evidenceRoot, "nested"), { recursive: true });

    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        pid: 456,
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.releaseUnit).toMatchObject({
      channel: "local-beta",
      sourceHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json"
    });
    expect(status.summary).toMatchObject({
      blockingErrorRows: 0,
      failedQueueJobs: 0,
      staleReviewLeases: 0
    });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE KEY|ghp_|BEGIN RSA|BEGIN OPENSSH/);
  });

  it("adds public release manifest gates while allowing an explicit source beta license API deferral", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-green-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md",
        websiteRepo: "electricsheephq/neon-diff-agent"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending",
        trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot/issues/111",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceState: "pending_secret_and_website_publish",
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot/issues/111"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        desktop: {
          requiredForThisRelease: false,
          state: "post_1_0",
          trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot/issues/116"
        }
      }
    }));

    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      publicRelease: readPublicReleaseManifestStatus({
        cwd: root,
        manifestPath: "public-release.json",
        expectedVersion: "v1.0.0-beta.1"
      }),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.publicRelease).toMatchObject({
      ok: true,
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      licenseApi: {
        ok: true,
        state: "pending",
        requiredForThisRelease: false
      }
    });
    expect(status.gates).toContainEqual({
      name: "public_docs_version",
      ok: true,
      detail: "manifest version v1.0.0-beta.1, docs version v1.0.0-beta.1, and CHANGELOG head 1.0.0-beta.1 match v1.0.0-beta.1; checked setup, release notes, and changelog paths"
    });
    expect(status.gates).toContainEqual({
      name: "public_license_api_state",
      ok: true,
      detail: "license API state pending; requiredForThisRelease=false"
    });
    expect(status.gates).toContainEqual({
      name: "public_update_channels",
      ok: true,
      detail: "cli=source_checkout; daemon=launchd_prerelease; desktop=post_1_0 (not required)"
    });
  });

  it("validates the shipped public release manifest against the shipped release notes", () => {
    // Intentional shipped-manifest smoke: keep assertions scoped to publicRelease fields.
    const manifest = readPublicReleaseManifestStatus({
      cwd: repoRoot,
      manifestPath: "docs/public-release-manifest.json",
      expectedVersion: "v0.4.45-beta.1",
      now: shippedReleaseValidationNow
    });

    expect(manifest).toMatchObject({
      ok: true,
      version: "v0.4.45-beta.1",
      docs: {
        ok: true,
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v0.4.45-beta.1.md",
        changelogPath: "CHANGELOG.md",
        changelogHeadVersion: "0.4.45-beta.1",
        changelogReleaseNotesPath: "docs/releases/v0.4.45-beta.1.md"
      },
      licenseApi: {
        ok: true,
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://neondiff-license.fly.dev/healthz",
        healthProofPath: "docs/evidence/v0.4.45-beta.1-license-api-healthz.json",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceUrl: "https://neondiff-license.fly.dev/v1/admin/licenses/issue",
        checkoutIssuanceState: "pending_secret_and_website_publish",
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
      },
      updateChannels: {
        ok: true
      }
    });
    expect(manifest.updateChannels.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "cli",
          requiredForThisRelease: true,
          rollback: "git reset --hard refs/tags/v0.4.44-beta.1"
        }),
        expect.objectContaining({
          name: "daemon",
          requiredForThisRelease: true,
          rollback: "git reset --hard refs/tags/v0.4.44-beta.1"
        })
      ])
    );
  });

  it("documents the shipped public release health proof expiry mode", () => {
    const manifest = readPublicReleaseManifestStatus({
      cwd: repoRoot,
      manifestPath: "docs/public-release-manifest.json",
      expectedVersion: "v0.4.45-beta.1",
      now: new Date("2026-08-08T00:00:00Z")
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: false,
      requiredForThisRelease: true,
      state: "healthy",
      healthProofPath: "docs/evidence/v0.4.45-beta.1-license-api-healthz.json"
    });
    expect(manifest.licenseApi.detail).toContain("observedAt must be no older than 30 days");
    expect(manifest.ok).toBe(false);
  });

  it("fails the public docs gate when CHANGELOG head lags the manifest version", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-changelog-drift-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v0.4.43-beta.1.md"), "# v0.4.43-beta.1\n");
    writeChangelogHead(root, "0.4.42-beta.1", "docs/releases/v0.4.42-beta.1.md");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v0.4.43-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v0.4.43-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v0.4.43-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          rollback: "git reset --hard refs/tags/v0.4.42-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          rollback: "git reset --hard refs/tags/v0.4.42-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v0.4.43-beta.1"
    });

    expect(manifest.ok).toBe(false);
    expect(manifest.docs).toMatchObject({
      ok: false,
      changelogHeadVersion: "0.4.42-beta.1",
      changelogReleaseNotesPath: "docs/releases/v0.4.42-beta.1.md"
    });
    expect(manifest.docs.detail).toContain("CHANGELOG head 0.4.42-beta.1 does not match 0.4.43-beta.1");
    expect(manifest.docs.detail).toContain("CHANGELOG release notes path docs/releases/v0.4.42-beta.1.md does not match docs/releases/v0.4.43-beta.1.md");
  });

  it("fails closed when public release manifest flags are not paired", () => {
    expect(() =>
      validatePublicReleaseManifestInputs({
        publicReleaseManifestPath: "docs/public-release-manifest.json"
      })
    ).toThrow("--expected-public-version is required when --public-release-manifest is provided");
    expect(() =>
      validatePublicReleaseManifestInputs({
        expectedPublicVersion: "v1.0.0-beta.1"
      })
    ).toThrow("--public-release-manifest is required when --expected-public-version is provided");
    expect(() =>
      validatePublicReleaseManifestInputs({
        publicReleaseManifestPath: "docs/public-release-manifest.json",
        expectedPublicVersion: "<tag>"
      })
    ).toThrow("--expected-public-version must be a semver tag like v1.0.0 or v1.0.0-beta.1");
  });

  it("accepts stable public release versions for future stable manifests", () => {
    expect(() =>
      validatePublicReleaseManifestInputs({
        publicReleaseManifestPath: "docs/public-release-manifest.json",
        expectedPublicVersion: "v1.0.0"
      })
    ).not.toThrow();
    expect(() =>
      validatePublicReleaseManifestInputs({
        publicReleaseManifestPath: "docs/public-release-manifest.json",
        expectedPublicVersion: "v1.0.0-beta.1+build.5"
      })
    ).not.toThrow();
    expect(() =>
      validatePublicReleaseManifestInputs({
        publicReleaseManifestPath: "docs/public-release-manifest.json",
        expectedPublicVersion: "v01.0.0"
      })
    ).toThrow("--expected-public-version must be a semver tag like v1.0.0 or v1.0.0-beta.1");
  });

  it("rejects oversized public release version inputs before semver matching", () => {
    const oversizedVersion = `v1.0.0-${"a.".repeat(300)}`;

    expect(() =>
      validatePublicReleaseManifestInputs({
        publicReleaseManifestPath: "docs/public-release-manifest.json",
        expectedPublicVersion: oversizedVersion
      })
    ).toThrow("--expected-public-version is too long (max 128 characters)");
  });

  it("collects public release manifest gates through release-status wiring", () => {
    // Intentional shipped-manifest smoke: surrounding repo/live-path status is machine-local.
    const root = mkdtempSync(join(tmpdir(), "release-status-public-manifest-"));
    roots.push(root);

    const status = collectReleaseStatus({
      cwd: repoRoot,
      statePath: join(root, "missing-live-state.sqlite"),
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      publicReleaseManifestPath: "docs/public-release-manifest.json",
      expectedPublicVersion: "v0.4.45-beta.1",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: shippedReleaseValidationNow
    });

    expect(status.publicRelease).toMatchObject({
      ok: true,
      version: "v0.4.45-beta.1"
    });
    expect(status.gates).toContainEqual({
      name: "public_update_channels",
      ok: true,
      detail: "cli=published; daemon=launchd_prerelease; website=published (not required); desktop=post_1_0 (not required)"
    });
    const redactedOutput = stringifyRedactedJson({
      ...status,
      healthState: status.ok ? "runtime_ok" : "runtime_blocked",
      runtimeOk: status.ok
    });
    expect(redactedOutput).toContain("git reset --hard refs/tags/v0.4.44-beta.1");
    expect(redactedOutput).toContain("cli=published; daemon=launchd_prerelease");
    expect(redactedOutput).toContain("https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327");
  });

  it("fails closed without throwing when collectReleaseStatus receives a missing public manifest path", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-missing-public-manifest-"));
    roots.push(root);

    const status = collectReleaseStatus({
      cwd: repoRoot,
      statePath: join(root, "missing-live-state.sqlite"),
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      publicReleaseManifestPath: "docs/not-a-public-release-manifest.json",
      expectedPublicVersion: "v1.0.0-beta.1",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot"
    });

    expect(status.publicRelease).toMatchObject({
      ok: false,
      version: "(missing)",
      docs: {
        ok: false,
        detail: "public release manifest missing at docs/not-a-public-release-manifest.json"
      }
    });
    expect(status.gates).toContainEqual({
      name: "public_docs_version",
      ok: false,
      detail: "public release manifest missing at docs/not-a-public-release-manifest.json"
    });
  });

  it("fails closed without throwing when the public manifest is invalid JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-invalid-json-"));
    roots.push(root);
    writeFileSync(join(root, "public-release.json"), "{ not valid json");

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest).toMatchObject({
      ok: false,
      version: "(invalid)",
      docs: {
        ok: false
      },
      licenseApi: {
        ok: false,
        state: "invalid"
      },
      updateChannels: {
        ok: false,
        channels: []
      }
    });
    expect(manifest.docs.detail).toContain("public release manifest is invalid JSON");
  });

  it("redacts secret-like public manifest strings before release-status JSON output", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-redaction-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending",
        healthUrl: "https://license.example/status?access_token=abcdefghijklmnopqrstuvwxyz"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });
    const redactedOutput = stringifyRedactedJson({
      publicRelease: manifest,
      healthState: manifest.ok ? "runtime_ok" : "runtime_blocked"
    });

    expect(manifest.licenseApi.healthUrl).toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redactedOutput).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(redactedOutput).toContain("[redacted-secret]");
  });

  it("does not append empty health-proof detail when proof is not required", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-optional-proof-detail-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending",
        healthUrl: "https://license.example/healthz",
        healthProofPath: "docs/evidence/retained-health-proof.json",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceState: "pending_secret_and_website_publish",
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: true,
      requiredForThisRelease: false,
      state: "pending",
      healthProofPath: "docs/evidence/retained-health-proof.json",
      detail: "license API state pending; requiredForThisRelease=false"
    });
  });

  it("preserves Date values when redacting JSON output", () => {
    const redactedOutput = stringifyRedactedJson({
      checkedAt: new Date("2026-07-04T00:00:00.000Z"),
      nested: {
        generatedAt: new Date("2026-07-04T00:01:00.000Z")
      }
    });

    expect(redactedOutput).toContain("\"checkedAt\": \"2026-07-04T00:00:00.000Z\"");
    expect(redactedOutput).toContain("\"generatedAt\": \"2026-07-04T00:01:00.000Z\"");
    expect(redactedOutput).not.toContain("\"checkedAt\": {}");
  });

  it("fails public docs gate when the expected public version is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-no-version-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json"
    });

    expect(manifest.ok).toBe(false);
    expect(manifest.docs).toMatchObject({
      ok: false,
      detail: "--expected-public-version is required"
    });
  });

  it("fails public docs gate when required docs paths are omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-no-doc-paths-"));
    roots.push(root);
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.ok).toBe(false);
    expect(manifest.docs.detail).toBe(
      "manifest version v1.0.0-beta.1 matches v1.0.0-beta.1; docs version v1.0.0-beta.1 matches v1.0.0-beta.1; CHANGELOG head 1.0.0-beta.1 matches 1.0.0-beta.1; setupPath missing at (missing); releaseNotesPath missing at (missing)"
    );
  });

  it("fails public docs gate when release notes path does not match the expected version", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-wrong-release-notes-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v0.9.0-beta.1.md"), "# v0.9.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v0.9.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.docs.ok).toBe(false);
    expect(manifest.docs.detail).toContain("release notes path docs/releases/v0.9.0-beta.1.md does not match docs/releases/v1.0.0-beta.1.md");
    expect(manifest.ok).toBe(false);
  });

  it("fails public docs gate when the expected version has malformed prerelease identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-malformed-prerelease-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta..1.md"), "# v1.0.0-beta..1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta..1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta..1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta..1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta..1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta..1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta..1"
    });

    expect(manifest.docs.ok).toBe(false);
    expect(manifest.docs.detail).toContain("--expected-public-version must be a semver tag like v1.0.0 or v1.0.0-beta.1");
    expect(manifest.ok).toBe(false);
  });

  it("fails public update channel gates when required channels are omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-channels-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        desktop: {
          requiredForThisRelease: false,
          state: "post_1_0",
          trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot/issues/116"
        }
      }
    }));

    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      publicRelease: readPublicReleaseManifestStatus({
        cwd: root,
        manifestPath: "public-release.json",
        expectedVersion: "v1.0.0-beta.1"
      }),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.publicRelease?.updateChannels).toMatchObject({
      ok: false,
      channels: [
        { name: "cli", ok: false, state: "missing", requiredForThisRelease: true },
        { name: "daemon", ok: false, state: "missing", requiredForThisRelease: true },
        { name: "desktop", ok: true, state: "post_1_0", requiredForThisRelease: false }
      ]
    });
    expect(status.gates).toContainEqual({
      name: "public_update_channels",
      ok: false,
      detail: "cli=missing [BLOCKED]; daemon=missing [BLOCKED]; desktop=post_1_0 (not required)"
    });
  });

  it("blocks license API deferrals outside source-beta releases", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-stable-license-deferral-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "stable",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: false,
      requiredForThisRelease: true,
      state: "pending"
    });
    expect(manifest.licenseApi.detail).toContain("license API state pending blocks this release");
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("blocks required healthy license API gates without committed health proof", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath: "docs/evidence/missing-health-proof.json"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: false,
      requiredForThisRelease: true,
      state: "healthy",
      healthProofPath: "docs/evidence/missing-health-proof.json"
    });
    expect(manifest.licenseApi.detail).toContain("missing health proof docs/evidence/missing-health-proof.json");
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("blocks checkout issuance gates when required but no proof is committed", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-issuance-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: false,
      requiredForThisRelease: true,
      state: "healthy",
      checkoutIssuanceRequiredForThisRelease: true,
      checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
    });
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("requires checkout issuance proof by default for source-beta releases", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-source-beta-issuance-default-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("requires a tracking issue when source-beta checkout issuance proof is deferred", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-source-beta-issuance-deferral-no-issue-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(false);
    expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBe(false);
    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceTrackingIssue must be present when checkout issuance proof is deferred"
    );
    expect(manifest.ok).toBe(false);
  });

  it("requires a tracking issue when source-beta license and checkout issuance are both deferred", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-source-beta-license-issuance-deferred-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceState: "pending_secret_and_website_publish"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(false);
    expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBe(false);
    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceTrackingIssue must be present when checkout issuance proof is deferred"
    );
    expect(manifest.ok).toBe(false);
  });

  it("requires checkout issuance proof by default when source-beta license API is deferred and issuance declaration is omitted", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-source-beta-license-deferred-issuance-default-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBeUndefined();
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.licenseApi.detail).toContain("checkoutIssuanceUrl must be present");
    expect(manifest.ok).toBe(false);
  });

  it("requires checkout issuance state to match explicit source-beta deferral", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-source-beta-issuance-deferral-ready-state-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceState: "ready",
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceState must be a deferred state when checkout issuance proof is deferred"
    );
    expect(manifest.ok).toBe(false);
  });

  it("honors explicit source-beta checkout issuance requirement when the license API is deferred", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-source-beta-license-deferred-issuance-required-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending",
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBe(true);
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("requires checkout issuance proof by default for public beta releases", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-beta-issuance-default-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("blocks stable and beta releases from deferring checkout issuance with only a tracking issue", () => {
    for (const releaseLevel of ["stable", "beta"]) {
      const releaseVersion = releaseLevel === "stable" ? "v1.0.0" : "v1.0.0-beta.1";
      const changelogVersion = releaseVersion.replace(/^v/, "");
      const root = mkdtempSync(join(tmpdir(), `public-release-manifest-${releaseLevel}-issuance-deferral-`));
      roots.push(root);
      mkdirSync(join(root, "docs", "releases"), { recursive: true });
      writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
      writeFileSync(join(root, "docs", "releases", `${releaseVersion}.md`), `# ${releaseVersion}\n`);
      writeChangelogHead(root, changelogVersion, `docs/releases/${releaseVersion}.md`);
      const healthProofPath = writeLicenseHealthProof(root, {
        releaseVersion,
        url: "https://license.example/healthz"
      });
      writeFileSync(join(root, "public-release.json"), JSON.stringify({
        version: releaseVersion,
        releaseLevel,
        docs: {
          version: releaseVersion,
          setupPath: "docs/SETUP.md",
          releaseNotesPath: `docs/releases/${releaseVersion}.md`
        },
        licenseApi: {
          requiredForThisRelease: true,
          state: "healthy",
          healthUrl: "https://license.example/healthz",
          healthProofPath,
          checkoutIssuanceRequiredForThisRelease: false,
          checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
        },
        updateChannels: {
          cli: {
            requiredForThisRelease: true,
            state: releaseLevel === "stable" ? "published" : "source_checkout",
            version: releaseVersion,
            rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
          },
          daemon: {
            requiredForThisRelease: true,
            state: "launchd_prerelease",
            version: releaseVersion,
            rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
          }
        }
      }));

      const manifest = readPublicReleaseManifestStatus({
        cwd: root,
        manifestPath: "public-release.json",
        expectedVersion: releaseVersion
      });

      expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
      expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBe(false);
      expect(manifest.licenseApi.detail).toContain(
        "checkoutIssuanceRequiredForThisRelease:false is only allowed for source-beta releases"
      );
      expect(manifest.ok).toBe(false);
    }
  });

  it("keeps checkout issuance deferral diagnostics visible when health proof is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-issuance-deferral-invalid-health-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0.md"), "# v1.0.0\n");
    writeChangelogHead(root, "1.0.0", "docs/releases/v1.0.0.md");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0",
      releaseLevel: "stable",
      docs: {
        version: "v1.0.0",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "published",
          version: "v1.0.0",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBe(false);
    expect(manifest.licenseApi.detail).toContain("missing health proof path");
    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceRequiredForThisRelease:false is only allowed for source-beta releases"
    );
    expect(manifest.ok).toBe(false);
  });

  it("keeps required checkout issuance proof diagnostics visible when health proof is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-issuance-required-invalid-health-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "not-a-healthz-url",
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain("healthUrl must be an https URL ending in /healthz");
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("keeps checkout issuance deferral diagnostics visible when license state is pending", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-issuance-deferral-pending-state-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0.md"), "# v1.0.0\n");
    writeChangelogHead(root, "1.0.0", "docs/releases/v1.0.0.md");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0",
      releaseLevel: "stable",
      docs: {
        version: "v1.0.0",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "pending",
        healthUrl: "https://license.example/healthz",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "published",
          version: "v1.0.0",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.checkoutIssuanceRequiredDeclaredForThisRelease).toBe(false);
    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceRequiredForThisRelease:false is only allowed for source-beta releases"
    );
    expect(manifest.ok).toBe(false);
  });

  it("requires checkout issuance proof by default for stable releases", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-stable-issuance-default-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0.md"), "# v1.0.0\n");
    writeChangelogHead(root, "1.0.0", "docs/releases/v1.0.0.md");
    const healthProofPath = writeLicenseHealthProof(root, {
      releaseVersion: "v1.0.0",
      url: "https://license.example/healthz"
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0",
      releaseLevel: "stable",
      docs: {
        version: "v1.0.0",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "published",
          version: "v1.0.0",
          rollback: "git reset --hard refs/tags/v0.4.45-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0",
          rollback: "git reset --hard refs/tags/v0.4.45-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0"
    });

    expect(manifest.licenseApi.checkoutIssuanceRequiredForThisRelease).toBe(true);
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("accepts required checkout issuance proof without exposing a raw license key", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-valid-issuance-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    const checkoutIssuanceProofPath = writeLicenseIssuanceProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue",
        checkoutIssuanceState: "ready",
        checkoutIssuanceProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: true,
      checkoutIssuanceRequiredForThisRelease: true,
      checkoutIssuanceRequiredDeclaredForThisRelease: true,
      checkoutIssuanceState: "ready",
      checkoutIssuanceProofPath
    });
    expect(manifest.licenseApi.detail).toContain(`validated checkout issuance proof ${checkoutIssuanceProofPath}`);
    expect(JSON.stringify(manifest)).not.toMatch(/nd_live_|LICENSE_ISSUANCE_SECRET|Bearer /);
    expect(manifest.ok).toBe(true);
  });

  it("blocks deferred checkout issuance state when proof is required", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-required-issuance-deferred-state-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    const checkoutIssuanceProofPath = writeLicenseIssuanceProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue",
        checkoutIssuanceState: "pending_secret_and_website_publish",
        checkoutIssuanceProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceState must be ready when checkout issuance proof is required"
    );
    expect(manifest.ok).toBe(false);
  });

  it("blocks stale or future checkout issuance proofs when release-status supplies a run timestamp", () => {
    for (const scenario of [
      {
        suffix: "stale",
        observedAt: "2026-06-06T23:59:59.000Z",
        expectedDetail: "observedAt must be no older than 30 days"
      },
      {
        suffix: "future",
        observedAt: "2026-07-07T00:06:00.000Z",
        expectedDetail: "observedAt must not be more than 5 minutes in the future"
      }
    ]) {
      const root = mkdtempSync(join(tmpdir(), `public-release-manifest-${scenario.suffix}-issuance-proof-`));
      roots.push(root);
      mkdirSync(join(root, "docs", "releases"), { recursive: true });
      writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
      writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
      writeChangelogHead(root);
      const healthProofPath = writeLicenseHealthProof(root, {
        observedAt: "2026-07-07T00:00:00.000Z"
      });
      const checkoutIssuanceProofPath = writeLicenseIssuanceProof(root, {
        observedAt: scenario.observedAt
      });
      writeFileSync(join(root, "public-release.json"), JSON.stringify({
        version: "v1.0.0-beta.1",
        releaseLevel: "source-beta",
        docs: {
          version: "v1.0.0-beta.1",
          setupPath: "docs/SETUP.md",
          releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
        },
        licenseApi: {
          requiredForThisRelease: true,
          state: "healthy",
          healthUrl: "https://license.example/healthz",
          healthProofPath,
          checkoutIssuanceRequiredForThisRelease: true,
          checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue",
          checkoutIssuanceProofPath
        },
        updateChannels: {
          cli: {
            requiredForThisRelease: true,
            state: "source_checkout",
            version: "v1.0.0-beta.1",
            rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
          },
          daemon: {
            requiredForThisRelease: true,
            state: "launchd_prerelease",
            version: "v1.0.0-beta.1",
            rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
          }
        }
      }));

      const manifest = readPublicReleaseManifestStatus({
        cwd: root,
        manifestPath: "public-release.json",
        expectedVersion: "v1.0.0-beta.1",
        now: new Date("2026-07-07T00:00:00.000Z")
      });

      expect(manifest.licenseApi.detail).toContain(scenario.expectedDetail);
      expect(manifest.ok).toBe(false);
    }
  });

  it("blocks checkout issuance proof paths that leave docs/evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-outside-issuance-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    const checkoutIssuanceProofPath = writeLicenseIssuanceProof(root, {
      path: "operator-local-proof.json"
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue",
        checkoutIssuanceProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain(
      "invalid checkout issuance proof operator-local-proof.json: checkoutIssuanceProofPath must be relative and stay within docs/evidence"
    );
    expect(manifest.ok).toBe(false);
  });

  it("blocks tampered checkout issuance proof bodies", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-tampered-issuance-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    const checkoutIssuanceProofPath = writeLicenseIssuanceProof(root, {
      responseBody: "{\"status\":\"forbidden\"}",
      responseBodySha256: "not-the-body-hash"
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue",
        checkoutIssuanceProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain("responseBodySha256 must match responseBody");
    expect(manifest.licenseApi.detail).toContain("responseBody.status must be unauthorized");
    expect(manifest.ok).toBe(false);
  });

  it("blocks checkout issuance URLs that do not match the license health host", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-issuance-host-mismatch-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath,
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://other-license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain("checkoutIssuanceUrl host must match healthUrl host license.example");
    expect(manifest.ok).toBe(false);
  });

  it("blocks checkout issuance host validation when healthUrl is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-issuance-invalid-health-url-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "pending",
        healthUrl: "not-a-healthz-url",
        checkoutIssuanceRequiredForThisRelease: true,
        checkoutIssuanceUrl: "https://license.example/v1/admin/licenses/issue"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.detail).toContain("healthUrl must be an https URL ending in /healthz");
    expect(manifest.licenseApi.detail).toContain(
      "checkoutIssuanceUrl host cannot be validated because healthUrl is missing or invalid"
    );
    expect(manifest.ok).toBe(false);
  });

  it("blocks required healthy license API gates when healthProofPath leaves docs/evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-outside-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root, { path: "operator-local-proof.json" });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: false,
      requiredForThisRelease: true,
      state: "healthy",
      healthProofPath
    });
    expect(manifest.licenseApi.detail).toContain(
      "invalid health proof operator-local-proof.json: healthProofPath must be relative and stay within docs/evidence"
    );
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("blocks required healthy license API gates when healthProofPath is absolute", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-absolute-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeLicenseHealthProof(root);
    const healthProofPath = join(root, "docs", "evidence", "license-healthz.json");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.healthProofPath).toBe(healthProofPath);
    expect(manifest.licenseApi.detail).toContain("healthProofPath must be relative and stay within docs/evidence");
    expect(manifest.ok).toBe(false);
  });

  it("blocks required healthy license API gates when healthUrl is missing", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-health-url-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.detail).toContain("healthUrl must be present when validating health proof");
    expect(manifest.ok).toBe(false);
  });

  it("validates optional license health metadata when fields are present", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-optional-invalid-health-metadata-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending",
        healthUrl: "http://license.example/status?access_token=abcdefghijklmnopqrstuvwxyz",
        healthProofPath: "../operator-local-proof.json"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.detail).toContain("healthUrl must be an https URL ending in /healthz");
    expect(manifest.licenseApi.detail).toContain("healthProofPath must be relative and stay within docs/evidence");
    expect(manifest.ok).toBe(false);
  });

  it("accepts a symlinked health proof only after realpath confinement", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-symlink-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "evidence"), { recursive: true });
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeChangelogHead(root);
    writeLicenseHealthProof(root, { path: "docs/evidence/license-healthz-target.json" });
    symlinkSync("license-healthz-target.json", join(root, "docs", "evidence", "license-healthz-link.json"));
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath: "docs/evidence/license-healthz-link.json",
        checkoutIssuanceRequiredForThisRelease: false,
        checkoutIssuanceState: "pending_secret_and_website_publish",
        checkoutIssuanceTrackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: true,
      requiredForThisRelease: true,
      state: "healthy",
      healthProofPath: "docs/evidence/license-healthz-link.json",
      detail: "license API state healthy; requiredForThisRelease=true; validated health proof docs/evidence/license-healthz-link.json"
    });
    expect(manifest.ok).toBe(true);
  });

  it("blocks required healthy license API gates when the proof file is not machine-checkable JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-invalid-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "evidence"), { recursive: true });
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "docs", "evidence", "not-json.json"), "# not json\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath: "docs/evidence/not-json.json"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi).toMatchObject({
      ok: false,
      requiredForThisRelease: true,
      state: "healthy",
      healthProofPath: "docs/evidence/not-json.json"
    });
    expect(manifest.licenseApi.detail).toContain(
      "invalid health proof docs/evidence/not-json.json: proof JSON is invalid"
    );
    expect(manifest.licenseApi.detail).toContain("missing checkout issuance proof path");
    expect(manifest.ok).toBe(false);
  });

  it("blocks required healthy license API gates when machine-checkable proof fields do not match", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-mismatched-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root, {
      evidenceKind: "not_license_api_healthz",
      releaseVersion: "v1.0.0-beta.0",
      observedAt: "not-a-date",
      method: "POST",
      url: "https://license.example/wrong",
      statusCode: 503,
      responseBodySha256: "not-the-body-hash",
      captureContext: {}
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.detail).toContain("evidenceKind must be license_api_healthz");
    expect(manifest.licenseApi.detail).toContain("releaseVersion must match v1.0.0-beta.1");
    expect(manifest.licenseApi.detail).toContain("url must match https://license.example/healthz");
    expect(manifest.licenseApi.detail).toContain("method must be GET");
    expect(manifest.licenseApi.detail).toContain("statusCode must be 200");
    expect(manifest.licenseApi.detail).toContain("observedAt must be a valid ISO timestamp");
    expect(manifest.licenseApi.detail).toContain("responseBodySha256 must match responseBody");
    expect(manifest.licenseApi.detail).toContain("captureContext.tool must be present");
    expect(manifest.licenseApi.detail).toContain("captureContext.transport must be present");
    expect(manifest.licenseApi.detail).toContain("captureContext.tlsValidation must be present");
    expect(manifest.licenseApi.detail).toContain("captureContext.capturedFrom must be present");
    expect(manifest.ok).toBe(false);
  });

  it("blocks stale or future health proofs when release-status supplies a run timestamp", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-stale-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root, {
      observedAt: "2026-06-06T23:59:59.000Z"
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1",
      now: new Date("2026-07-07T00:00:00.000Z")
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.detail).toContain("observedAt must be no older than 30 days");
    expect(manifest.ok).toBe(false);
  });

  it("checks health proof freshness when callers omit now", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));

    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-default-now-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root, {
      observedAt: "2026-06-06T23:59:59.000Z"
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.detail).toContain("observedAt must be no older than 30 days");
    expect(manifest.ok).toBe(false);
  });

  it("blocks health proofs observed too far in the future", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-future-health-proof-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root, {
      observedAt: "2026-07-07T00:06:00.000Z"
    });
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1",
      now: new Date("2026-07-07T00:00:00.000Z")
    });

    expect(manifest.licenseApi.ok).toBe(false);
    expect(manifest.licenseApi.detail).toContain("observedAt must not be more than 5 minutes in the future");
    expect(manifest.ok).toBe(false);
  });

  it("blocks optional channel deferrals outside source-beta releases", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-stable-channel-deferral-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    const healthProofPath = writeLicenseHealthProof(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "stable",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "healthy",
        healthUrl: "https://license.example/healthz",
        healthProofPath
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        website: {
          requiredForThisRelease: false,
          state: "pending-site-sync"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels).toContainEqual(expect.objectContaining({
      name: "website",
      requiredForThisRelease: true,
      ok: false,
      detail: "website state pending-site-sync blocks this release; requiredForThisRelease=true; missing version, rollback command"
    }));
    expect(manifest.updateChannels.ok).toBe(false);
    expect(manifest.ok).toBe(false);
  });

  it("fails public release gates for unknown required license and update-channel states", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-unknown-states-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "unknown"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source-chekout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      publicRelease: readPublicReleaseManifestStatus({
        cwd: root,
        manifestPath: "public-release.json",
        expectedVersion: "v1.0.0-beta.1"
      }),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    const licenseGate = status.gates.find((gate) => gate.name === "public_license_api_state");
    expect(licenseGate).toMatchObject({ name: "public_license_api_state", ok: false });
    expect(licenseGate?.detail).toContain("license API state unknown blocks this release");
    expect(licenseGate?.detail).toContain("missing checkout issuance proof path");
    expect(status.gates).toContainEqual({
      name: "public_update_channels",
      ok: false,
      detail: "cli=source-chekout [BLOCKED]; daemon=launchd_prerelease"
    });
  });

  it("fails required public update channels without version and rollback or tracking evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-channel-metadata-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          trackingIssue: "https://github.com/electricsheephq/evaos-code-review-bot/issues/112"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels).toEqual([
      expect.objectContaining({
        name: "cli",
        ok: false,
        detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing version, rollback command"
      }),
      expect.objectContaining({
        name: "daemon",
        ok: false,
        detail: "daemon state launchd_prerelease blocks this release; requiredForThisRelease=true; missing rollback command"
      })
    ]);
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("forces policy-mandatory public update channels to remain required", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-mandatory-channel-opt-out-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: false,
          state: "pending"
        },
        daemon: {
          requiredForThisRelease: false,
          state: "pending"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels).toEqual([
      expect.objectContaining({
        name: "cli",
        requiredForThisRelease: true,
        ok: false,
        detail: "cli state pending blocks this release; requiredForThisRelease=true; missing version, rollback command"
      }),
      expect.objectContaining({
        name: "daemon",
        requiredForThisRelease: true,
        ok: false,
        detail: "daemon state pending blocks this release; requiredForThisRelease=true; missing version, rollback command"
      })
    ]);
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails required public update channels with restart-only rollback commands", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-restart-rollback-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails required public update channels with chained rollback commands", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-chained-rollback-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1 && launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails optional public update channels with another channel's specific state", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-cross-channel-state-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        website: {
          requiredForThisRelease: false,
          state: "post_1_0"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels.find((channel) => channel.name === "website")).toMatchObject({
      ok: false,
      detail: "website state post_1_0 blocks this release; requiredForThisRelease=false"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails required public update channels when rollback-like text is not the command", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-embedded-rollback-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "echo git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails required public update channels when checkout only resets the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-checkout-worktree-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git checkout ."
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("accepts format-valid rollback targets without requiring local refs by default", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-rollback-ref-"));
    roots.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v9.9.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git revert 0123456789abcdef0123456789abcdef01234567"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels).toEqual([
      expect.objectContaining({
        name: "cli",
        ok: true,
        detail: "cli state source_checkout; requiredForThisRelease=true"
      }),
      expect.objectContaining({
        name: "daemon",
        ok: true,
        detail: "daemon state launchd_prerelease; requiredForThisRelease=true"
      })
    ]);
    expect(manifest.updateChannels.ok).toBe(true);
  });

  it("can fail required public update channels when rollback target verification is enabled", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-missing-rollback-ref-"));
    roots.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v9.9.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git revert 0123456789abcdef0123456789abcdef01234567"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1",
      verifyRollbackRefs: true
    });

    expect(manifest.updateChannels.channels).toEqual([
      expect.objectContaining({
        name: "cli",
        ok: false,
        detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback target"
      }),
      expect.objectContaining({
        name: "daemon",
        ok: false,
        detail: "daemon state launchd_prerelease blocks this release; requiredForThisRelease=true; missing rollback target"
      })
    ]);
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("passes required public update channels when strict rollback targets exist in a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-existing-rollback-ref-"));
    roots.push(root);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=evaOS Bot", "-c", "user.email=bot@example.invalid", "commit", "--allow-empty", "-m", "seed"], {
      cwd: root,
      stdio: "ignore"
    });
    execFileSync("git", ["tag", "v0.4.9-beta.1"], { cwd: root, stdio: "ignore" });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: `git revert ${headSha}`
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1",
      verifyRollbackRefs: true
    });

    expect(manifest.updateChannels.channels).toEqual([
      expect.objectContaining({
        name: "cli",
        ok: true,
        detail: "cli state source_checkout; requiredForThisRelease=true"
      }),
      expect.objectContaining({
        name: "daemon",
        ok: true,
        detail: "daemon state launchd_prerelease; requiredForThisRelease=true"
      })
    ]);
    expect(manifest.updateChannels.ok).toBe(true);
  });

  it("fails required public update channels when rollback uses an ambiguous plain tag target", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-plain-tag-rollback-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard v0.4.9-beta.1"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails required public update channels when rollback uses an abbreviated SHA", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-short-sha-rollback-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git revert abc1234"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails required public update channels when rollback includes trailing operands", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-trailing-rollback-"));
    roots.push(root);
    mkdirSync(join(root, "docs", "releases"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeFileSync(join(root, "docs", "releases", "v1.0.0-beta.1.md"), "# v1.0.0-beta.1\n");
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "source-beta",
      docs: {
        version: "v1.0.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: false,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "source_checkout",
          version: "v1.0.0-beta.1",
          rollback: "git reset --hard refs/tags/v0.4.9-beta.1 extra"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease",
          version: "v1.0.0-beta.1",
          rollback: "git revert 0123456789abcdef0123456789abcdef01234567 unexpected"
        }
      }
    }));

    const manifest = readPublicReleaseManifestStatus({
      cwd: root,
      manifestPath: "public-release.json",
      expectedVersion: "v1.0.0-beta.1"
    });

    expect(manifest.updateChannels.channels[0]).toMatchObject({
      name: "cli",
      ok: false,
      detail: "cli state source_checkout blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.channels[1]).toMatchObject({
      name: "daemon",
      ok: false,
      detail: "daemon state launchd_prerelease blocks this release; requiredForThisRelease=true; missing rollback command"
    });
    expect(manifest.updateChannels.ok).toBe(false);
  });

  it("fails public release gates for stale docs, required pending license API, and blocked channels", () => {
    const root = mkdtempSync(join(tmpdir(), "public-release-manifest-red-"));
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "SETUP.md"), "# Setup\n");
    writeChangelogHead(root);
    writeFileSync(join(root, "public-release.json"), JSON.stringify({
      version: "v1.0.0-beta.1",
      releaseLevel: "public-beta",
      docs: {
        version: "v0.9.0-beta.1",
        setupPath: "docs/SETUP.md",
        releaseNotesPath: "docs/releases/v1.0.0-beta.1.md"
      },
      licenseApi: {
        requiredForThisRelease: true,
        state: "pending"
      },
      updateChannels: {
        cli: {
          requiredForThisRelease: true,
          state: "pending"
        },
        daemon: {
          requiredForThisRelease: true,
          state: "launchd_prerelease"
        }
      }
    }));

    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      publicRelease: readPublicReleaseManifestStatus({
        cwd: root,
        manifestPath: "public-release.json",
        expectedVersion: "v1.0.0-beta.1"
      }),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "public_release_level",
      ok: false,
      detail: "release level public-beta is not one of beta, source-beta, stable"
    });
    expect(status.gates).toContainEqual({
      name: "public_docs_version",
      ok: false,
      detail: "manifest version v1.0.0-beta.1 matches v1.0.0-beta.1; docs version v0.9.0-beta.1 does not match v1.0.0-beta.1; CHANGELOG head 1.0.0-beta.1 matches 1.0.0-beta.1; release notes missing at docs/releases/v1.0.0-beta.1.md"
    });
    expect(status.gates).toContainEqual({
      name: "public_license_api_state",
      ok: false,
      detail: "license API state pending blocks this release; requiredForThisRelease=true"
    });
    expect(status.gates).toContainEqual({
      name: "public_update_channels",
      ok: false,
      detail: "cli=pending [BLOCKED]; daemon=launchd_prerelease [BLOCKED]"
    });
    expect(status.recommendedActions).toContain("inspect public release manifest public-release.json");
  });

  it("fails closed when launchd config path cannot be verified", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running"
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({ name: "launchd_config", ok: false, detail: "not detected" });
  });

  it("fails closed when launchd reports Node without the macOS system CA option", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--trace-warnings",
        usesSystemCa: false
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "launchd_node_system_ca",
      ok: false,
      detail: "NODE_OPTIONS missing --use-system-ca"
    });
  });

  it("fails closed when launchd NODE_OPTIONS cannot be verified", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "launchd_node_system_ca",
      ok: false,
      detail: "NODE_OPTIONS not detected"
    });
  });

  it("parses launchd NODE_OPTIONS from the loaded service environment", () => {
    const status = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\tpid = 57466
\targuments = {
\t\t/opt/homebrew/bin/node
\t\tsrc/cli.ts
\t\tdaemon
\t\t--config
\t\t/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
\t\t--dry-run
\t\tfalse
\t}
\tenvironment = {
\t\tNODE_OPTIONS => --use-system-ca --trace-warnings
\t}
}
`);

    expect(status).toMatchObject({
      state: "running",
      pid: 57466,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      dryRun: false,
      nodeOptions: "--use-system-ca --trace-warnings",
      usesSystemCa: true
    });
  });

  it("normalizes quoted launchd NODE_OPTIONS and requires the exact system CA flag", () => {
    const status = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\tenvironment = {
\t\tNODE_OPTIONS => "\t--use-system-ca   --trace-warnings\t"
\t}
}
`);

    expect(status.nodeOptions).toBe("--use-system-ca   --trace-warnings");
    expect(status.usesSystemCa).toBe(true);

    const substringOnly = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\tenvironment = {
\t\tNODE_OPTIONS => "--use-system-ca-proxy"
\t}
}
`);

    expect(substringOnly.nodeOptions).toBe("--use-system-ca-proxy");
    expect(substringOnly.usesSystemCa).toBe(false);
  });

  it("leaves launchd system CA undetected when the loaded service environment block is absent", () => {
    const status = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\targuments = {
\t\t/opt/homebrew/bin/node
\t\tsrc/cli.ts
\t\tdaemon
\t\t--config
\t\t/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
\t}
}
`);

    expect(status.usesSystemCa).toBeUndefined();
    expect(status.nodeOptions).toBeUndefined();
  });

  it("parses NODE_OPTIONS from a launchctl print excerpt with adjacent environment sections", () => {
    const status = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\tpid = 57466
\targuments = {
\t\t/opt/homebrew/bin/node
\t\t/Volumes/LEXAR/repos/evaos-code-review-bot/node_modules/tsx/dist/cli.mjs
\t\tsrc/cli.ts
\t\tdaemon
\t\t--config
\t\t/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
\t\t--dry-run
\t\tfalse
\t}
\tinherited environment = {
\t\tSSH_AUTH_SOCK => /var/run/com.apple.launchd.example/Listeners
\t}
\tdefault environment = {
\t\tPATH => /usr/bin:/bin:/usr/sbin:/sbin
\t}
\tenvironment = {
\t\tOSLogRateLimit => 64
\t\tPATH => /opt/homebrew/bin:/usr/bin:/bin
\t\tNODE_OPTIONS => --use-system-ca
\t\tSHELL => /bin/zsh
\t}
}
`);

    expect(status).toMatchObject({
      state: "running",
      pid: 57466,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      dryRun: false,
      nodeOptions: "--use-system-ca",
      usesSystemCa: true
    });
  });

  it("marks launchd system CA as disabled when the loaded service environment omits it", () => {
    const status = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\targuments = {
\t\t/opt/homebrew/bin/node
\t\tsrc/cli.ts
\t\tdaemon
\t\t--config
\t\t/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
\t}
\tenvironment = {
\t\tPATH => /usr/bin:/bin
\t}
}
`);

    expect(status.usesSystemCa).toBe(false);
    expect(status.nodeOptions).toBeUndefined();
  });

  it("does not match NODE_OPTIONS text embedded inside another environment value", () => {
    const status = parseLaunchdPrintStatus("com.electricsheephq.evaos-code-review-bot", `
gui/502/com.electricsheephq.evaos-code-review-bot = {
\tstate = running
\tenvironment = {
\t\tPATH => /usr/bin:/bin NODE_OPTIONS => --use-system-ca
\t}
}
`);

    expect(status.usesSystemCa).toBe(false);
    expect(status.nodeOptions).toBeUndefined();
  });

  it("fails closed when promotion is attempted from a non-main branch", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "sprint/2-release-cadence",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({ name: "release_branch", ok: false, detail: "sprint/2-release-cadence" });
  });

  it("treats baseline skipped rows as non-blocking database state", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({ name: "live_db_no_errors", ok: true, detail: "0 blocking error row(s)" });
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: true,
      detail: "fresh; age 1000ms; max 120000ms; event daemon_cycle_complete; cycle 5"
    });
    expect(status.database.skippedCount).toBe(16);
  });

  it("reports active provider cooldown skips without treating them as blocking DB errors", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: {
        rowCount: 21,
        errorCount: 0,
        skippedCount: 16,
        providerCooldownCount: 1,
        activeProviderCooldownCount: 1,
        expiredProviderCooldownCount: 0
      },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "live_db_no_errors",
      ok: true,
      detail: "0 blocking error row(s); 1 provider cooldown skip row(s) (1 active, 0 expired)"
    });
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: true,
      detail: "0 expired provider cooldown row(s); 1 active provider cooldown row(s)"
    });
    expect(status.recommendedActions).toEqual([]);
  });

  it("fails the provider cooldown backlog gate and recommends exact retry commands for expired rows", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: {
        rowCount: 21,
        errorCount: 0,
        skippedCount: 16,
        providerCooldownCount: 2,
        activeProviderCooldownCount: 1,
        expiredProviderCooldownCount: 1
      },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    const retryCommand =
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true";
    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: false,
      detail: `1 expired provider cooldown row(s); 1 active provider cooldown row(s); retry: ${retryCommand}`
    });
    expect(status.recommendedActions).toContain(retryCommand);
  });

  it("keeps release status green when expired per-head cooldowns are covered by an active provider throttle", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: {
        rowCount: 21,
        errorCount: 0,
        skippedCount: 16,
        providerCooldownCount: 2,
        activeProviderCooldownCount: 1,
        expiredProviderCooldownCount: 1,
        providerThrottleState: "active",
        coveredExpiredProviderCooldownCount: 1
      },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: true,
      detail: "provider throttle active; 1 expired provider cooldown row(s) deferred by active provider cooldown"
    });
    expect(status.recommendedActions).toEqual([]);
  });

  it("counts active and expired provider cooldown rows from the live state database", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-db-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const expiredUntil = new Date(Date.now() - 60_000).toISOString();
    const activeUntil = new Date(Date.now() + 60_000).toISOString();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table daemon_heartbeat (
          id integer primary key check (id = 1),
          cycle integer,
          event text,
          dry_run integer,
          recorded_at text,
          error text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        220,
        "expired-head",
        `provider_rate_limit_cooldown_until=${expiredUntil}; reason=provider_rate_limit`
      );
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        220,
        "active-head",
        `provider_rate_limit_cooldown_until=${activeUntil}; reason=provider_rate_limit`
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot"
    });

    expect(status.database.providerCooldownCount).toBe(2);
    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.activeProviderCooldownCount).toBe(1);
    expect(status.recommendedActions[0]).toBe(
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true"
    );
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("covers expired provider cooldown rows when the same head has an active queue retry", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-covered-cooldown-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "covered-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1128,
        "uncovered-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      insertQueueJob(db, "running", "electricsheephq/WorldOS", "covered-head", undefined, { pullNumber: 1127 });
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    const retryCommand =
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true";
    expect(status.database.providerCooldownCount).toBe(2);
    expect(status.database.expiredProviderCooldownCount).toBe(2);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(1);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(1);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: false,
      detail: `1 expired provider cooldown row(s) covered by active queue retry; 1 retryable expired provider cooldown row(s); 0 active provider cooldown row(s); retry: ${retryCommand}`
    });
  });

  it("keeps release status green when all expired provider cooldown rows are covered by active queue retries", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-covered-cooldown-green-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "covered-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      insertQueueJob(db, "running", "electricsheephq/WorldOS", "covered-head", undefined, { pullNumber: 1127 });
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.database.providerCooldownCount).toBe(1);
    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(1);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(0);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: true,
      detail: "1 expired provider cooldown row(s) covered by active queue retry; 0 retryable expired provider cooldown row(s); 0 active provider cooldown row(s)"
    });
    expect(status.recommendedActions).not.toContain(
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true"
    );
  });

  it("does not cover expired provider cooldown rows with expired queue leases", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-expired-lease-cooldown-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "expired-lease-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'leased', ?, ?, ?, ?)`
      ).run(
        "leased-expired-lease-head",
        "automatic:electricsheephq/WorldOS#1127@expired-lease-head",
        "electricsheephq/WorldOS",
        "electricsheephq",
        1127,
        "expired-lease-head",
        "lease-expired",
        "2026-07-01T00:04:00.000Z",
        "2026-06-30T23:00:00.000Z",
        "2026-06-30T23:00:00.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(0);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(0);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(1);
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("does not cover expired provider cooldown rows with stale null queue leases", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-stale-null-lease-cooldown-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "stale-null-lease-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, null, ?, ?)`
      ).run(
        "running-stale-null-lease-head",
        "automatic:electricsheephq/WorldOS#1127@stale-null-lease-head",
        "electricsheephq/WorldOS",
        "electricsheephq",
        1127,
        "stale-null-lease-head",
        "lease-without-expiry",
        "2026-06-30T23:00:00.000Z",
        "2026-06-30T23:00:00.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:20:00.000Z")
    });

    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(0);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(0);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(1);
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("reports reviewer session counts from the live state database", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-reviewer-sessions-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table reviewer_sessions (
          session_id text primary key,
          repo text not null,
          repo_family text,
          state text not null,
          started_at text not null,
          last_used_at text not null,
          expires_at text not null,
          head_count_used integer not null,
          head_count_limit integer not null,
          worker_pid integer,
          model text,
          provider text,
          zcode_cli_version text,
          memory_packet_sha text,
          gitnexus_packet_sha text,
          last_error text
        );
      `);
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "active-session",
        "100yenadmin/evaOS-GUI",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:30:00.000Z",
        1,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "expired-session",
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        "expired",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:10:00.000Z",
        10,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "stale-active-session",
        "electricsheephq/WorldOS",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:10:00.000Z",
        1,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "limit-reached-active-session",
        "electricsheephq/evaos-code-review-bot",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:30:00.000Z",
        10,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit, worker_pid)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "dead-worker-active-session",
        "electricsheephq/evaos-code-review-bot",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:30:00.000Z",
        1,
        10,
        999_999_999
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:15:00.000Z")
    });

    expect(status.database.reviewerSessionCount).toBe(5);
    expect(status.database.activeReviewerSessionCount).toBe(1);
    expect(status.database.expiredReviewerSessionCount).toBe(3);
    expect(status.database.reviewerSessionsByRepo).toHaveLength(4);
    expect(status.database.reviewerSessionsByRepo).toEqual(
      expect.arrayContaining([
        { repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO", total: 1, active: 0, expired: 1 },
        { repo: "100yenadmin/evaOS-GUI", total: 1, active: 1, expired: 0 },
        { repo: "electricsheephq/WorldOS", total: 1, active: 0, expired: 1 },
        { repo: "electricsheephq/evaos-code-review-bot", total: 2, active: 0, expired: 1 }
      ])
    );
  });

  it("reports durable review queue counts and fails retryable deferred or failed jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-review-queue-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      insertQueueJob(db, "queued", "electricsheephq/WorldOS", "queued-head");
      insertQueueJob(db, "running", "electricsheephq/WorldOS", "running-head");
      insertQueueJob(db, "provider_deferred", "100yenadmin/evaOS-GUI", "deferred-head", "2026-07-01T00:10:00.000Z");
      insertQueueJob(db, "provider_deferred", "100yenadmin/evaOS-GUI", "retryable-head", "2026-07-01T00:01:00.000Z");
      insertQueueJob(db, "failed", "100yenadmin/Lossless-Codex-Orchestrator-LCO", "failed-head");
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.database).toMatchObject({
      reviewQueueJobCount: 5,
      queuedReviewQueueJobCount: 1,
      runningReviewQueueJobCount: 1,
      providerDeferredReviewQueueJobCount: 2,
      retryableProviderDeferredReviewQueueJobCount: 1,
      failedReviewQueueJobCount: 1
    });
    expect(status.budget).toMatchObject({
      active: {
        total: 1,
        running: 1
      },
      queued: {
        total: 3,
        providerDeferred: 2,
        retryableProviderDeferred: 1
      },
      providerDeferred: {
        total: 2,
        retryable: 1,
        readyToRetry: 1,
        waitingCooldown: 1
      },
      delayedByReason: {
        repo_capacity: 1,
        provider_cooldown: 1
      },
      wouldLeaseCount: 1,
      delayedCount: 2,
      details: {
        included: false,
        wouldLeaseReturned: 0,
        delayedReturned: 0,
        detailsTruncated: true
      },
      wouldLease: [],
      delayed: []
    });
    expect(status.database.reviewQueueJobsByRepo).toEqual([
      {
        repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        total: 1,
        queued: 0,
        leased: 0,
        running: 0,
        providerDeferred: 0,
        retryableProviderDeferred: 0,
        failed: 1
      },
      {
        repo: "100yenadmin/evaOS-GUI",
        total: 2,
        queued: 0,
        leased: 0,
        running: 0,
        providerDeferred: 2,
        retryableProviderDeferred: 1,
        failed: 0
      },
      {
        repo: "electricsheephq/WorldOS",
        total: 2,
        queued: 1,
        leased: 0,
        running: 1,
        providerDeferred: 0,
        retryableProviderDeferred: 0,
        failed: 0
      }
    ]);
    expect(status.gates).toContainEqual({
      name: "queue_no_failed_jobs",
      ok: false,
      detail: "1 failed durable queue job(s)"
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: false,
      detail: "1 ready-to-retry provider-deferred queue job(s); provider_deferred total=2 retryable=1 waiting_cooldown=1 waiting_capacity=0; queue total=5 queued=1 leased=0 running=1 provider_deferred=2 failed=1"
    });
    expect(status.recommendedActions).toContain("wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry");

    const detailedStatus = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      budgetDetails: true,
      budgetDetailLimit: 1,
      budgetJobLimit: 3,
      now: new Date("2026-07-01T00:05:00.000Z")
    });
    expect(detailedStatus.budget?.details).toMatchObject({
      included: true,
      detailLimit: 1,
      inputJobLimit: 3,
      inputJobsTruncated: false,
      detailsTruncated: true
    });
    expect(detailedStatus.budget?.wouldLease.length).toBeLessThanOrEqual(1);
    expect(detailedStatus.budget?.delayed.length).toBeLessThanOrEqual(1);
  });

  it("does not fail the provider-deferred gate when retryable jobs are waiting on capacity", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: {
        rowCount: 21,
        errorCount: 0,
        reviewQueueJobCount: 2,
        queuedReviewQueueJobCount: 0,
        leasedReviewQueueJobCount: 0,
        runningReviewQueueJobCount: 1,
        providerDeferredReviewQueueJobCount: 1,
        retryableProviderDeferredReviewQueueJobCount: 1,
        failedReviewQueueJobCount: 0
      },
      budget: releaseBudgetStatus({
        queued: {
          total: 1,
          manual: 0,
          background: 1,
          providerDeferred: 1,
          retryableProviderDeferred: 1
        },
        providerDeferred: {
          total: 1,
          retryable: 1,
          readyToRetry: 0,
          waitingCooldown: 0,
          waitingProviderCapacity: 1,
          waitingOrgCapacity: 0,
          waitingRepoCapacity: 0,
          waitingManualReserve: 0,
          waitingLeaseLimit: 0
        }
      }),
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: true,
      detail: "0 ready-to-retry provider-deferred queue job(s); provider_deferred total=1 retryable=1 waiting_cooldown=0 waiting_capacity=1; queue total=2 queued=0 leased=0 running=1 provider_deferred=1 failed=0"
    });
    expect(status.recommendedActions).not.toContain("wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry");
  });

  it("recommends review queue lease cleanup when stale run leases or active queue leases exist", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-stale-review-leases-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_run_leases (
          lease_id text primary key,
          started_at text not null,
          expires_at text not null,
          owner_pid integer
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare("insert into review_run_leases (lease_id, started_at, expires_at, owner_pid) values (?, ?, ?, ?)")
        .run("dead-owner", "2026-07-03T08:00:00.000Z", "2026-07-03T09:00:00.000Z", 999_999_999);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, ?, ?, ?)`
      ).run(
        "stale-running",
        "automatic:electricsheephq/evaos-code-review-bot#174@head-a",
        "electricsheephq/evaos-code-review-bot",
        "electricsheephq",
        174,
        "head-a",
        "queue-lease-expired",
        "2026-07-03T08:00:10.000Z",
        "2026-07-03T08:00:00.000Z",
        "2026-07-03T08:00:00.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.database).toMatchObject({
      reviewRunLeaseCount: 1,
      staleReviewRunLeaseCount: 1,
      staleActiveReviewQueueJobCount: 1
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: false,
      detail: "1 stale review run lease(s); 1 stale active queue job(s)"
    });
    expect(status.recommendedActions).toContain(
      "npx tsx src/cli.ts clear-review-queue-leases --config (default config) --dry-run true --expired-only true"
    );
  });

  it("counts fresh null-owner review run leases as stale", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-null-owner-run-lease-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const store = new ReviewStateStore(dbPath);
    store.close();
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("insert into review_run_leases (lease_id, started_at, expires_at, owner_pid) values (?, ?, ?, ?)")
        .run("null-owner", "2026-07-03T08:00:00.000Z", "2026-07-03T09:00:00.000Z", null);
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.database).toMatchObject({
      reviewRunLeaseCount: 1,
      staleReviewRunLeaseCount: 1
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: false,
      detail: "1 stale review run lease(s); 0 stale active queue job(s)"
    });
  });

  it("does not flag fresh legacy null review queue leases before the TTL expires", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-fresh-null-review-lease-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, null, ?, ?)`
      ).run(
        "fresh-null-running",
        "automatic:electricsheephq/evaos-code-review-bot#176@head-null",
        "electricsheephq/evaos-code-review-bot",
        "electricsheephq",
        176,
        "head-null",
        "queue-lease-fresh-null",
        "2026-07-03T08:00:00.000Z",
        "2026-07-03T08:00:59.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.database.staleActiveReviewQueueJobCount).toBe(0);
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: true,
      detail: "0 stale review run lease(s); 0 stale active queue job(s)"
    });
  });

  it("flags malformed active review queue lease expiries as stale", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-malformed-review-lease-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, ?, ?, ?)`
      ).run(
        "malformed-running",
        "automatic:electricsheephq/evaos-code-review-bot#176@head-malformed",
        "electricsheephq/evaos-code-review-bot",
        "electricsheephq",
        176,
        "head-malformed",
        "queue-lease-malformed",
        "not-a-date",
        "2026-07-03T08:00:00.000Z",
        "2026-07-03T08:00:59.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.database.staleActiveReviewQueueJobCount).toBe(1);
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: false,
      detail: "0 stale review run lease(s); 1 stale active queue job(s)"
    });
  });

  it("filters terminal queue rows and preserves active jobs before applying the budget row cap", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-budget-cap-terminal-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      insertQueueJob(db, "posted", "owner/repo", "terminal-posted");
      insertQueueJob(db, "failed", "owner/repo", "terminal-failed");
      insertQueueJob(db, "queued", "owner/repo-a", "queued-a");
      insertQueueJob(db, "queued", "owner/repo-b", "queued-b");
      insertQueueJob(db, "running", "owner/repo-c", "live-running");
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      budgetJobLimit: 1,
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.budget).toMatchObject({
      active: {
        total: 1,
        running: 1
      },
      queued: {
        total: 1
      },
      details: {
        inputJobs: 2,
        inputJobLimit: 1,
        inputJobsTruncated: true
      }
    });
  });

  it("surfaces failed ZCode timeout queue jobs separately from provider cooldowns", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-zcode-timeout-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, last_error, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 1, 'failed', ?, ?, ?)`
      ).run(
        "timeout-failed",
        "automatic:electricsheephq/evaos-code-review-bot-neondiff#216@head-timeout",
        "electricsheephq/evaos-code-review-bot-neondiff",
        "electricsheephq",
        216,
        "head-timeout",
        "zcode_timeout_retryable; reason=zcode_hard_timeout; retry_attempt=1; timeout_ms=1200000; original_error=ZCode failed before completion: spawnSync node ETIMEDOUT",
        "2026-07-04T13:12:57.000Z",
        "2026-07-04T13:12:57.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-04T13:15:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.summary).toMatchObject({
      failedQueueJobs: 1,
      zcodeTimeoutFailedQueueJobs: 1,
      retryableZCodeTimeoutFailedQueueJobs: 1
    });
    expect(status.database).toMatchObject({
      zcodeTimeoutFailedReviewQueueJobCount: 1,
      retryableZCodeTimeoutFailedReviewQueueJobCount: 1,
      exhaustedZCodeTimeoutFailedReviewQueueJobCount: 0
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_zcode_timeout_failed_jobs",
      ok: false,
      detail: "1 ZCode timeout failed durable queue job(s); retryable=1 exhausted=0"
    });
    expect(status.recommendedActions).toContain(
      "npx tsx src/cli.ts queue --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --state failed"
    );
  });

  it("treats malformed provider cooldown timestamps as actionable backlog", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-db-invalid-cooldown-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        220,
        "malformed-head",
        "provider_rate_limit_cooldown_until=not-a-date; reason=provider_rate_limit"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot"
    });

    expect(status.database.providerCooldownCount).toBe(1);
    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.activeProviderCooldownCount).toBe(0);
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("fails closed when the daemon heartbeat is missing", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: { status: "missing", maxAgeMs: 120_000 },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: false,
      detail: "missing heartbeat row; max age 120000ms"
    });
  });

  it("fails closed when the daemon heartbeat is stale", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: {
        status: "stale",
        maxAgeMs: 120_000,
        latestAt: "2026-06-30T23:57:00.000Z",
        ageMs: 180_000,
        cycle: 5,
        event: "daemon_cycle_complete",
        dryRun: false
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: false,
      detail: "stale; age 180000ms; max 120000ms; event daemon_cycle_complete; cycle 5"
    });
  });

  it("treats a bounded active daemon cycle as a healthy heartbeat", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false,
        nodeOptions: "--use-system-ca",
        usesSystemCa: true
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: {
        status: "active",
        maxAgeMs: 120_000,
        activeMaxAgeMs: 420_000,
        latestAt: "2026-06-30T23:57:00.000Z",
        ageMs: 180_000,
        cycle: 5,
        event: "daemon_cycle_complete",
        dryRun: false,
        activeCycle: 6,
        activeStartedAt: "2026-06-30T23:59:00.000Z",
        activeAgeMs: 60_000
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: true,
      detail: "active; active age 60000ms; max 420000ms; started cycle 6; last event daemon_cycle_complete; last cycle 5"
    });
  });
});

function freshHeartbeat() {
  return {
    status: "fresh" as const,
    maxAgeMs: 120_000,
    latestAt: "2026-06-30T23:59:59.000Z",
    ageMs: 1_000,
    cycle: 5,
    event: "daemon_cycle_complete",
    dryRun: false
  };
}

function releaseBudgetStatus(overrides: Partial<ReviewBudgetStatus> = {}): ReviewBudgetStatus {
  return {
    enabled: true,
    checkedAt: "2026-07-01T00:00:00.000Z",
    config: {
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 60_000
      },
      scheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      }
    },
    active: {
      total: 1,
      leased: 0,
      running: 1,
      manual: 0,
      background: 1,
      byProvider: [],
      byOrg: [],
      byRepo: []
    },
    queued: {
      total: 0,
      manual: 0,
      background: 0,
      providerDeferred: 0,
      retryableProviderDeferred: 0
    },
    providerDeferred: {
      total: 0,
      retryable: 0,
      readyToRetry: 0,
      waitingCooldown: 0,
      waitingProviderCapacity: 0,
      waitingOrgCapacity: 0,
      waitingRepoCapacity: 0,
      waitingManualReserve: 0,
      waitingLeaseLimit: 0
    },
    manualReserve: {
      configured: 0,
      activeManual: 0,
      queuedManual: 0,
      reservedSlotsOpen: 0,
      backgroundSlotsAvailableBeforeReserve: 1
    },
    wouldLeaseCount: 0,
    delayedCount: 0,
    details: {
      included: false,
      wouldLeaseReturned: 0,
      delayedReturned: 0,
      detailsTruncated: false,
      inputJobs: 0
    },
    wouldLease: [],
    delayed: [],
    delayedByReason: {},
    ...overrides
  };
}

function insertQueueJob(
  db: DatabaseSync,
  state: string,
  repo: string,
  headSha: string,
  nextEligibleAt?: string,
  options: { pullNumber?: number } = {}
): void {
  const pullNumber = options.pullNumber ?? 1;
  db.prepare(
    `insert into review_queue_jobs
      (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
       priority, state, next_eligible_at, created_at, updated_at)
     values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, ?, ?, ?, ?)`
  ).run(
    `${state}-${pullNumber}-${headSha}`,
    `automatic:${repo}#${pullNumber}@${headSha}`,
    repo,
    repo.split("/")[0],
    pullNumber,
    headSha,
    state,
    nextEligibleAt ?? null,
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );
}
