import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runLicenseLifecycleSmoke } from "../src/license-lifecycle-smoke.js";

describe("license lifecycle smoke", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("keeps the trusted wrapper on GitHub OIDC without secret arguments or shared-secret stdin", () => {
    const script = readFileSync(resolve(repoRoot, "scripts", "run-license-lifecycle-smoke.mjs"), "utf8");
    expect(script).toContain("requestGitHubActionsOidcToken");
    expect(script).not.toMatch(/readSecretFromStdin|--issuance-secret|authorization:\s*`Bearer/);
  });

  it("issues a disposable production key, drives the candidate through stdin, and emits only redacted bound evidence", async () => {
    const rawKey = ["nd", "live", "disposableLifecycleFixture123"].join("_");
    const oidcToken = ["header", "claims", "signature"].join(".");
    const candidateHead = "a".repeat(40);
    const packShasum = "b".repeat(40);
    const packIntegrity = `sha512-${"Y".repeat(86)}==`;
    const runnerCalls: Array<{ args: string[]; stdin?: string }> = [];
    let validateAfterDeactivation = false;
    let localRemoved = false;

    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.4",
      candidateHead,
      packShasum,
      packIntegrity,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceAuthorization: { kind: "github-oidc", bearer: oidcToken },
      candidateCliPath: "/isolated/prefix/bin/neondiff",
      configPath: "/isolated/config.local.json",
      confirmLiveLifecycle: true,
      now: () => new Date("2026-07-12T04:00:00.000Z"),
      randomId: () => "c".repeat(32),
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/admin/licenses/issue-lifecycle") {
          expect(init?.headers).toMatchObject({ authorization: `Bearer ${oidcToken}` });
          expect(JSON.parse(String(init?.body))).toEqual({
            releaseVersion: "v1.0.4",
            candidateHead,
            packShasum,
            packIntegrity
          });
          return new Response(JSON.stringify({
            status: "issued",
            replayed: false,
            licenseKey: rawKey,
            entitlement: { status: "active", repoVisibilityScope: "private", privateRepoAllowed: true, updateEntitlement: true }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/v1/license/validate" && validateAfterDeactivation) {
          return new Response(JSON.stringify({ status: "scope_mismatch", detail: "machine is not activated" }), {
            status: 409,
            headers: { "content-type": "application/json" }
          });
        }
        throw new Error(`unexpected fake API path ${path}`);
      },
      runCandidateCommand: async ({ args, stdin }) => {
        runnerCalls.push({ args, ...(stdin ? { stdin } : {}) });
        expect(args.join(" ")).not.toContain(rawKey);
        if (args[1] === "activate") {
          expect(stdin).toBe(`${rawKey}\n`);
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "active", source: "api" }), stderr: "" };
        }
        if (args[1] === "status" && !localRemoved) {
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "active", source: "api" }), stderr: "" };
        }
        if (args[1] === "deactivate") {
          validateAfterDeactivation = true;
          localRemoved = true;
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "deactivated", apiNotified: true }), stderr: "" };
        }
        if (args[1] === "status" && localRemoved) {
          return { exitCode: 1, stdout: JSON.stringify({ ok: false, status: "missing", source: "none" }), stderr: "" };
        }
        throw new Error("unexpected candidate command");
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runnerCalls).toHaveLength(4);
    expect(runnerCalls[0]?.args).toEqual([
      "license", "activate", "--config", "/isolated/config.local.json", "--license-key-stdin", "true", "--json"
    ]);
    expect(runnerCalls[1]?.args).toEqual([
      "license", "status", "--config", "/isolated/config.local.json", "--refresh", "true", "--json"
    ]);
    expect(runnerCalls[2]?.args).toEqual([
      "license", "deactivate", "--config", "/isolated/config.local.json", "--notify-api", "true", "--json"
    ]);
    expect(runnerCalls[3]?.args).toEqual([
      "license", "status", "--config", "/isolated/config.local.json", "--json"
    ]);
    expect(result.artifact).toMatchObject({
      evidenceKind: "production-lifecycle",
      releaseVersion: "v1.0.4",
      candidateHead,
      packShasum,
      packIntegrity,
      records: [
        { id: "issue", outcome: "succeeded", statusCode: 200, redactedResponse: { status: "issued" } },
        { id: "activate", outcome: "succeeded", statusCode: 200, redactedResponse: { status: "active", source: "api" } },
        { id: "validate_active", outcome: "succeeded", statusCode: 200, redactedResponse: { status: "active", source: "api" } },
        { id: "deactivate", outcome: "succeeded", statusCode: 200, redactedResponse: { status: "deactivated" } },
        { id: "validate_denied", outcome: "denied", statusCode: 409, redactedResponse: { status: "scope_mismatch" } }
      ]
    });
    expect(result.lifecycle.steps).toEqual(result.artifact.records.map((record) => ({
      ...record,
      responseSha256: createHash("sha256").update(JSON.stringify(record.redactedResponse)).digest("hex")
    })));
    expect(result.licenseFingerprint).toBe(`sha256:${createHash("sha256").update(rawKey).digest("hex")}`);
    expect(JSON.stringify(result)).not.toContain(rawKey);
    expect(JSON.stringify(result)).not.toContain(oidcToken);
  });

  it("does not read or call live systems without explicit confirmation", async () => {
    let called = false;
    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceAuthorization: { kind: "shared-secret", bearer: "not-read" },
      candidateCliPath: "/isolated/prefix/bin/neondiff",
      configPath: "/isolated/config.local.json",
      confirmLiveLifecycle: false,
      fetchImpl: async () => {
        called = true;
        throw new Error("must not call");
      },
      runCandidateCommand: async () => {
        called = true;
        throw new Error("must not run");
      }
    });
    expect(result).toMatchObject({ ok: false, errorCode: "confirm_live_lifecycle_required" });
    expect(called).toBe(false);
  });

  it("accepts future stable release versions covered by the v1.0.4+ gate", async () => {
    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.5",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceAuthorization: { kind: "shared-secret", bearer: "fixture-secret" },
      candidateCliPath: "/isolated/prefix/bin/neondiff",
      configPath: "/isolated/config.local.json",
      confirmLiveLifecycle: true,
      fetchImpl: async () => new Response(JSON.stringify({ status: "server" }), { status: 500 }),
      runCandidateCommand: async () => {
        throw new Error("candidate must not run after failed issuance");
      }
    });
    expect(result).toMatchObject({ ok: false, errorCode: "issuance_failed" });
  });

  it("confirms local removal and remote revocation after a post-activation failure", async () => {
    const rawKey = ["nd", "live", "cleanupFixture123456"].join("_");
    let remoteRevoked = false;
    let localRemoved = false;
    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceAuthorization: { kind: "shared-secret", bearer: "fixture-secret" },
      candidateCliPath: "/isolated/prefix/bin/neondiff",
      configPath: "/isolated/config.local.json",
      confirmLiveLifecycle: true,
      randomId: () => "c".repeat(32),
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/admin/licenses/issue") {
          return new Response(JSON.stringify({ status: "issued", replayed: false, licenseKey: rawKey }), { status: 200 });
        }
        if (path === "/v1/license/deactivate") {
          remoteRevoked = true;
          return new Response(JSON.stringify({ status: "revoked" }), { status: 200 });
        }
        if (path === "/v1/license/validate") {
          return new Response(JSON.stringify({ status: remoteRevoked ? "scope_mismatch" : "active" }), { status: remoteRevoked ? 409 : 200 });
        }
        throw new Error("unexpected path");
      },
      runCandidateCommand: async ({ args }) => {
        if (args[1] === "activate") return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "active", source: "api" }), stderr: "" };
        if (args[1] === "status" && !localRemoved) return { exitCode: 1, stdout: JSON.stringify({ ok: false, status: "server" }), stderr: "" };
        if (args[1] === "deactivate" && args.includes("false")) {
          localRemoved = true;
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "deactivated" }), stderr: "" };
        }
        if (args[1] === "status" && localRemoved) return { exitCode: 1, stdout: JSON.stringify({ ok: false, status: "missing" }), stderr: "" };
        throw new Error("unexpected cleanup command");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "candidate_failed",
      cleanup: { localState: "confirmed_removed", remoteState: "confirmed_deactivated" }
    });
    expect(localRemoved).toBe(true);
    expect(remoteRevoked).toBe(true);
    expect(JSON.stringify(result)).not.toContain(rawKey);
  });

  it("reuses one issuance idempotency key across retries for the same candidate pack", async () => {
    const issuanceKeys: string[] = [];
    for (const randomId of ["c".repeat(32), "d".repeat(32)]) {
      await runLicenseLifecycleSmoke({
        releaseVersion: "v1.0.4",
        candidateHead: "a".repeat(40),
        packShasum: "b".repeat(40),
        packIntegrity: `sha512-${"Y".repeat(86)}==`,
        apiBaseUrl: "https://neondiff-license.fly.dev",
        issuanceAuthorization: { kind: "shared-secret", bearer: "fixture-secret" },
        candidateCliPath: "/isolated/prefix/bin/neondiff",
        configPath: "/isolated/config.local.json",
        confirmLiveLifecycle: true,
        now: () => new Date("2026-07-12T04:00:00.000Z"),
        randomId: () => randomId,
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { idempotencyKey: string };
          issuanceKeys.push(body.idempotencyKey);
          return new Response(JSON.stringify({ status: "server" }), { status: 500 });
        },
        runCandidateCommand: async () => {
          throw new Error("candidate must not run after failed issuance");
        }
      });
    }
    expect(issuanceKeys).toHaveLength(2);
    expect(issuanceKeys[0]).toBe(issuanceKeys[1]);
  });

  it("removes local state when activation persists the key but returns malformed output", async () => {
    const rawKey = ["nd", "live", "malformedActivationFixture"].join("_");
    let localRemoved = false;
    let remoteRevoked = false;
    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceAuthorization: { kind: "shared-secret", bearer: "fixture-secret" },
      candidateCliPath: "/isolated/prefix/bin/neondiff",
      configPath: "/isolated/config.local.json",
      confirmLiveLifecycle: true,
      randomId: () => "c".repeat(32),
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/admin/licenses/issue") {
          return new Response(JSON.stringify({ status: "issued", licenseKey: rawKey }), { status: 200 });
        }
        if (path === "/v1/license/deactivate") {
          remoteRevoked = true;
          return new Response(JSON.stringify({ status: "deactivated" }), { status: 200 });
        }
        if (path === "/v1/license/validate") {
          return new Response(JSON.stringify({ status: "scope_mismatch" }), { status: 409 });
        }
        throw new Error("unexpected API path");
      },
      runCandidateCommand: async ({ args }) => {
        if (args[1] === "activate") {
          return { exitCode: 1, stdout: "{truncated", stderr: "activation response interrupted" };
        }
        if (args[1] === "deactivate" && args.includes("false")) {
          localRemoved = true;
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "deactivated" }), stderr: "" };
        }
        if (args[1] === "status" && localRemoved) {
          return { exitCode: 1, stdout: JSON.stringify({ ok: false, status: "missing" }), stderr: "" };
        }
        throw new Error("unexpected candidate command");
      }
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: "candidate_failed",
      cleanup: { localState: "confirmed_removed", remoteState: "confirmed_deactivated" }
    });
    expect(localRemoved).toBe(true);
    expect(remoteRevoked).toBe(true);
  });
});
