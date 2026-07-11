import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runLicenseLifecycleSmoke } from "../src/license-lifecycle-smoke.js";

describe("license lifecycle smoke", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

  it("keeps the operator wrapper stdin-only for the issuance bearer", () => {
    const script = readFileSync(resolve(repoRoot, "scripts", "run-license-lifecycle-smoke.mjs"), "utf8");
    expect(script).toContain("readSecretFromStdin(process.stdin");
    expect(script).not.toMatch(/process\.env|--issuance-secret|authorization:\s*`Bearer/);
  });

  it("issues a disposable production key, drives the candidate through stdin, and emits only redacted bound evidence", async () => {
    const rawKey = ["nd", "live", "disposableLifecycleFixture123"].join("_");
    const issuanceSecret = ["issuance", "fixture", "secret"].join("-");
    const candidateHead = "a".repeat(40);
    const packShasum = "b".repeat(40);
    const packIntegrity = `sha512-${"Y".repeat(86)}==`;
    const runnerCalls: Array<{ args: string[]; stdin?: string }> = [];
    let validateAfterDeactivation = false;

    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.4",
      candidateHead,
      packShasum,
      packIntegrity,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceSecret,
      candidateCliPath: "/isolated/prefix/bin/neondiff",
      configPath: "/isolated/config.local.json",
      confirmLiveLifecycle: true,
      now: () => new Date("2026-07-12T04:00:00.000Z"),
      randomId: () => "c".repeat(32),
      fetchImpl: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === "/v1/admin/licenses/issue") {
          expect(init?.headers).toMatchObject({ authorization: `Bearer ${issuanceSecret}` });
          return new Response(JSON.stringify({
            status: "issued",
            replayed: false,
            licenseKey: rawKey,
            entitlement: { status: "active", repoVisibilityScope: "private", privateRepoAllowed: true, updateEntitlement: true }
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (path === "/v1/license/validate" && validateAfterDeactivation) {
          return new Response(JSON.stringify({ status: "revoked", detail: "license is revoked" }), {
            status: 403,
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
        if (args[1] === "status") {
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "active", source: "api" }), stderr: "" };
        }
        if (args[1] === "deactivate") {
          validateAfterDeactivation = true;
          return { exitCode: 0, stdout: JSON.stringify({ ok: true, status: "revoked", source: "api" }), stderr: "" };
        }
        throw new Error("unexpected candidate command");
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runnerCalls).toHaveLength(3);
    expect(runnerCalls[0]?.args).toEqual([
      "license", "activate", "--config", "/isolated/config.local.json", "--license-key-stdin", "true", "--json"
    ]);
    expect(runnerCalls[1]?.args).toEqual([
      "license", "status", "--config", "/isolated/config.local.json", "--refresh", "true", "--json"
    ]);
    expect(runnerCalls[2]?.args).toEqual([
      "license", "deactivate", "--config", "/isolated/config.local.json", "--notify-api", "true", "--json"
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
        { id: "deactivate", outcome: "succeeded", statusCode: 200, redactedResponse: { status: "revoked" } },
        { id: "validate_denied", outcome: "denied", statusCode: 403, redactedResponse: { status: "revoked" } }
      ]
    });
    expect(result.lifecycle.steps).toEqual(result.artifact.records.map((record) => ({
      ...record,
      responseSha256: createHash("sha256").update(JSON.stringify(record.redactedResponse)).digest("hex")
    })));
    expect(result.licenseFingerprint).toBe(`sha256:${createHash("sha256").update(rawKey).digest("hex")}`);
    expect(JSON.stringify(result)).not.toContain(rawKey);
    expect(JSON.stringify(result)).not.toContain(issuanceSecret);
  });

  it("does not read or call live systems without explicit confirmation", async () => {
    let called = false;
    const result = await runLicenseLifecycleSmoke({
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`,
      apiBaseUrl: "https://neondiff-license.fly.dev",
      issuanceSecret: "not-read",
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
});
