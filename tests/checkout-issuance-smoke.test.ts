import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCheckoutIssuanceSmokeRequestPreview,
  runCheckoutIssuanceSmoke,
  type CheckoutIssuanceFetch
} from "../src/checkout-issuance-smoke.js";
import { createInProcessLicenseApi } from "./helpers/in-process-license-api.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");
const TEST_PROVIDER_TUPLE = {
  providerAccountId: "acct_test_smoke_fixture",
  providerMode: "test",
  externalSubscriptionId: "sub_test_smoke_fixture",
  externalCheckoutId: "cs_test_smoke_fixture"
} as const;

describe("checkout issuance smoke", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "neondiff-checkout-issuance-smoke-"));
    tempRoots.push(root);
    return root;
  }

  it("requires explicit live confirmation before reading secrets or making a network request", async () => {
    const calls: unknown[] = [];
    const fetchImpl: CheckoutIssuanceFetch = async (...args) => {
      calls.push(args);
      throw new Error("fetch should not run");
    };

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: false,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: "owner-held-proof-key" },
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected confirmation failure");
    expect(result.errorCode).toBe("confirm_live_issuance_required");
    expect(calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("owner-held-proof-key");
  });

  it("fails before the HTTP call when the requested secret env var is missing", async () => {
    const calls: unknown[] = [];
    const fetchImpl: CheckoutIssuanceFetch = async (...args) => {
      calls.push(args);
      throw new Error("fetch should not run");
    };

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: {},
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected missing env failure");
    expect(result.errorCode).toBe("missing_secret_env");
    expect(result.secretEnvName).toBe("LICENSE_ISSUANCE_SECRET");
    expect(calls).toEqual([]);
  });

  it("rejects non-https URLs before reading the secret or making a network request", async () => {
    const calls: unknown[] = [];
    const fetchImpl: CheckoutIssuanceFetch = async (...args) => {
      calls.push(args);
      throw new Error("fetch should not run");
    };

    const result = await runCheckoutIssuanceSmoke({
      url: "http://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: "owner-held-proof-key" },
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid URL failure");
    expect(result.errorCode).toBe("invalid_url");
    expect(JSON.stringify(result)).not.toContain("owner-held-proof-key");
    expect(calls).toEqual([]);
  });

  it("posts the supported checkout request and writes only redacted success proof", async () => {
    const root = tempRoot();
    const outputPath = "docs/evidence/license-checkout-issuance-authenticated.json";
    const secretValue = "owner-held-proof-key";
    const licenseKey = ["nd", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    let observedRequest: { url: string; init: RequestInit | undefined } | undefined;
    const fetchImpl: CheckoutIssuanceFetch = async (url, init) => {
      observedRequest = { url: String(url), init };
      return jsonResponse(200, {
        status: "issued",
        replayed: false,
        checkoutLookupKey: "neondiff_yearly",
        licenseKey,
        entitlement: { status: "active" }
      });
    };

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_yearly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      idempotencyKey: "neondiff-smoke-v1.0.0-neondiff_yearly",
      outputPath,
      cwd: root,
      now: () => new Date("2026-07-08T12:00:00.000Z"),
      fetchImpl
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected success proof");
    expect(result.proofPath).toBe(outputPath);
    expect(observedRequest?.url).toBe("https://license.example/v1/admin/licenses/issue");
    expect(observedRequest?.init?.method).toBe("POST");
    expect(observedRequest?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(observedRequest?.init?.headers).toMatchObject({
      "content-type": "application/json",
      authorization: `Bearer ${secretValue}`
    });
    expect(JSON.parse(String(observedRequest?.init?.body))).toEqual({
      idempotencyKey: "neondiff-smoke-v1.0.0-neondiff_yearly",
      checkoutLookupKey: "neondiff_yearly",
      provider: "stripe",
      ...TEST_PROVIDER_TUPLE
    });

    const proofText = readFileSync(join(root, outputPath), "utf8");
    expect(proofText).not.toContain(secretValue);
    expect(proofText).not.toContain(licenseKey);
    expect(proofText).not.toContain("licenseKey");
    expect(proofText).not.toContain("Authorization");
    expect(proofText).not.toContain(TEST_PROVIDER_TUPLE.providerAccountId);
    expect(proofText).not.toContain(TEST_PROVIDER_TUPLE.externalSubscriptionId);
    expect(proofText).not.toContain(TEST_PROVIDER_TUPLE.externalCheckoutId);
    expect(JSON.parse(proofText)).toEqual({
      evidenceKind: "license_api_checkout_issuance_authenticated",
      releaseVersion: "v1.0.0",
      observedAt: "2026-07-08T12:00:00.000Z",
      method: "POST",
      url: "https://license.example/v1/admin/licenses/issue",
      statusCode: 200,
      redactedResponse: {
        status: "issued",
        replayed: false,
        checkoutLookupKey: "neondiff_yearly",
        issuedLicensePrefix: "nd_live_",
        issuedLicenseFingerprint: `sha256:${createHash("sha256").update(licenseKey).digest("hex")}`
      },
      captureContext: {
        tool: "neondiff checkout-issuance-smoke",
        transport: "https",
        tlsValidation: "node default CA validation",
        capturedFrom: "operator CLI"
      }
    });
  });

  it("passes the real API listener and rejects a test/live replay conflict without leaking correlation", async () => {
    const secretValue = "listener-fixture-issuance-secret";
    const api = createInProcessLicenseApi(secretValue);
    try {
      const baseInput = {
        url: "https://license.example/v1/admin/licenses/issue",
        releaseVersion: "v1.0.5",
        checkoutLookupKey: "neondiff_monthly",
        ...TEST_PROVIDER_TUPLE,
        idempotencyKey: "neondiff-smoke-v1.0.5-listener-fixture",
        confirmLiveIssuance: true,
        secretEnvName: "LICENSE_ISSUANCE_SECRET",
        env: { LICENSE_ISSUANCE_SECRET: secretValue },
        fetchImpl: api.fetchImpl
      } as const;

      expect((await runCheckoutIssuanceSmoke(baseInput)).ok).toBe(true);
      const crossed = await runCheckoutIssuanceSmoke({
        ...baseInput,
        providerMode: "live"
      });

      expect(crossed).toMatchObject({
        ok: false,
        errorCode: "unexpected_status",
        statusCode: 409
      });
      const serialized = JSON.stringify(crossed);
      for (const sensitive of [
        secretValue,
        TEST_PROVIDER_TUPLE.providerAccountId,
        TEST_PROVIDER_TUPLE.externalSubscriptionId,
        TEST_PROVIDER_TUPLE.externalCheckoutId
      ]) {
        expect(serialized).not.toContain(sensitive);
      }
    } finally {
      api.close();
    }
  });

  it("rejects a missing provider tuple before reading the bearer or calling the listener", async () => {
    let called = false;
    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.5",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      externalSubscriptionId: "",
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: "must-not-be-read" },
      fetchImpl: async () => {
        called = true;
        throw new Error("listener must not be called");
      }
    });

    expect(result).toMatchObject({ ok: false, errorCode: "invalid_provider_tuple" });
    expect(called).toBe(false);
    expect(JSON.stringify(result)).not.toContain("must-not-be-read");
    expect(JSON.stringify(result)).not.toContain(TEST_PROVIDER_TUPLE.providerAccountId);
  });

  it("rejects symlinked proof output targets inside docs/evidence", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "docs/evidence"), { recursive: true });
    const outsidePath = join(root, "outside-proof.json");
    writeFileSync(outsidePath, "outside");
    symlinkSync(outsidePath, join(root, "docs/evidence/license-checkout-issuance-authenticated.json"));
    const secretValue = "owner-held-proof-key";
    const licenseKey = ["nd", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(200, {
      status: "issued",
      replayed: false,
      licenseKey
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      outputPath: "docs/evidence/license-checkout-issuance-authenticated.json",
      cwd: root,
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid output path");
    expect(result.errorCode).toBe("invalid_output_path");
    expect(readFileSync(outsidePath, "utf8")).toBe("outside");
  });

  it("rejects proof output when an existing parent path escapes docs/evidence through a symlink", async () => {
    const root = tempRoot();
    const outsideDocs = join(root, "outside-docs");
    mkdirSync(outsideDocs, { recursive: true });
    symlinkSync(outsideDocs, join(root, "docs"));
    const secretValue = "owner-held-proof-key";
    const licenseKey = ["nd", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(200, {
      status: "issued",
      replayed: false,
      licenseKey
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      outputPath: "docs/evidence/license-checkout-issuance-authenticated.json",
      cwd: root,
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid output path");
    expect(result.errorCode).toBe("invalid_output_path");
  });

  it("rejects output paths outside docs/evidence before writing proof files", async () => {
    const root = tempRoot();
    const secretValue = "owner-held-proof-key";
    const licenseKey = ["nd", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(200, {
      status: "issued",
      replayed: false,
      licenseKey
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      outputPath: "../license-checkout-issuance-authenticated.json",
      cwd: root,
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid output path");
    expect(result.errorCode).toBe("invalid_output_path");
    expect(JSON.stringify(result)).not.toContain(licenseKey);
  });

  it("fails if the server echoes a different checkout lookup key than requested", async () => {
    const secretValue = "owner-held-proof-key";
    const licenseKey = ["nd", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(200, {
      status: "issued",
      replayed: false,
      checkoutLookupKey: "neondiff_yearly",
      licenseKey
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid success response");
    expect(result.errorCode).toBe("invalid_success_response");
    expect(JSON.stringify(result)).not.toContain(licenseKey);
  });

  it("omits provider failure bodies and never writes a success proof for non-200 responses", async () => {
    const root = tempRoot();
    const outputPath = "docs/evidence/license-checkout-issuance-authenticated.json";
    const secretValue = "owner-held-proof-key";
    const rawKey = "plain-license-key-that-does-not-match-token-patterns";
    const customerEmail = "buyer@example.com";
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(503, {
      status: "server",
      detail: `bad upstream key ${rawKey}`,
      licenseKey: rawKey,
      customerEmail,
      checkoutMetadata: {
        pastedSecret: "owner shared proof phrase"
      }
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      outputPath,
      cwd: root,
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected provider failure");
    expect(result.errorCode).toBe("unexpected_status");
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(JSON.stringify(result)).not.toContain(rawKey);
    expect(JSON.stringify(result)).not.toContain(customerEmail);
    expect(JSON.stringify(result)).not.toContain("owner shared proof phrase");
    expect("redactedResponseBody" in result).toBe(false);
    expect("proofPath" in result).toBe(false);
  });

  it("classifies non-200 non-JSON responses as unexpected status without parsing the body", async () => {
    const secretValue = "owner-held-proof-key";
    const fetchImpl: CheckoutIssuanceFetch = async () => new Response("<html>Private Buyer</html>", {
      status: 503,
      headers: { "content-type": "text/html" }
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected provider failure");
    expect(result.errorCode).toBe("unexpected_status");
    expect(JSON.stringify(result)).not.toContain("Private Buyer");
  });

  it("rejects oversized success responses before parsing proof bodies", async () => {
    const secretValue = "owner-held-proof-key";
    const licenseKey = ["nd", "live", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(200, {
      status: "issued",
      replayed: false,
      licenseKey,
      padding: "x".repeat(20_000)
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected oversized response failure");
    expect(result.errorCode).toBe("response_too_large");
    expect(JSON.stringify(result)).not.toContain(licenseKey);
  });

  it("omits malformed success bodies that include customer data or arbitrary keys", async () => {
    const secretValue = "owner-held-proof-key";
    const rawKey = "plain-license-key-that-does-not-match-token-patterns";
    const fetchImpl: CheckoutIssuanceFetch = async () => jsonResponse(200, {
      status: "issued",
      replayed: false,
      licenseKey: rawKey,
      customerName: "Private Buyer",
      authorization: `Bearer ${secretValue}`
    });

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: "LICENSE_ISSUANCE_SECRET",
      env: { LICENSE_ISSUANCE_SECRET: secretValue },
      fetchImpl
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected invalid success response");
    expect(result.errorCode).toBe("invalid_success_response");
    expect(JSON.stringify(result)).not.toContain(secretValue);
    expect(JSON.stringify(result)).not.toContain(rawKey);
    expect(JSON.stringify(result)).not.toContain("Private Buyer");
    expect("redactedResponseBody" in result).toBe(false);
  });

  it("redacts exported failure extra fields before callers stringify results directly", async () => {
    const mistakenSecretEnvName = "owner shared proof phrase";

    const result = await runCheckoutIssuanceSmoke({
      url: "https://license.example/v1/admin/licenses/issue",
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_monthly",
      ...TEST_PROVIDER_TUPLE,
      confirmLiveIssuance: true,
      secretEnvName: mistakenSecretEnvName,
      env: {},
      fetchImpl: async () => {
        throw new Error("fetch should not run");
      }
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(mistakenSecretEnvName);
  });

  it("supports dry-run request preview without a secret or network call", () => {
    const preview = buildCheckoutIssuanceSmokeRequestPreview({
      releaseVersion: "v1.0.0",
      checkoutLookupKey: "neondiff_org_yearly",
      ...TEST_PROVIDER_TUPLE
    });

    expect(preview).toEqual({
      idempotencyKey: "neondiff-smoke-v1.0.0-neondiff_org_yearly",
      checkoutLookupKey: "neondiff_org_yearly",
      provider: "stripe",
      ...TEST_PROVIDER_TUPLE
    });
  });

  it("exposes a dry-run CLI preview that does not require the owner-held secret", async () => {
    const output = await runCli([
      "checkout-issuance-smoke",
      "--url",
      "https://license.example/v1/admin/licenses/issue",
      "--release-version",
      "v1.0.0",
      "--checkout-lookup-key",
      "neondiff_org_yearly",
      "--provider-account-id",
      TEST_PROVIDER_TUPLE.providerAccountId,
      "--provider-mode",
      TEST_PROVIDER_TUPLE.providerMode,
      "--external-subscription-id",
      TEST_PROVIDER_TUPLE.externalSubscriptionId,
      "--external-checkout-id",
      TEST_PROVIDER_TUPLE.externalCheckoutId,
      "--secret-env",
      "LICENSE_ISSUANCE_SECRET",
      "--dry-run",
      "true"
    ]);

    expect(output.ok).toBe(true);
    expect(output.command).toBe("checkout-issuance-smoke");
    expect(output.mode).toBe("dry_run");
    expect(output.requestPreview).toEqual({
      idempotencyKey: "neondiff-smoke-v1.0.0-neondiff_org_yearly",
      checkoutLookupKey: "neondiff_org_yearly",
      provider: "stripe",
      ...TEST_PROVIDER_TUPLE
    });
    expect(JSON.stringify(output)).not.toContain("LICENSE_ISSUANCE_SECRET");
  });

  it("rejects plaintext URLs in CLI dry-run before presenting a request preview", async () => {
    await expect(runCli([
      "checkout-issuance-smoke",
      "--url",
      "http://license.example/v1/admin/licenses/issue",
      "--release-version",
      "v1.0.0",
      "--checkout-lookup-key",
      "neondiff_monthly",
      "--dry-run",
      "true"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("\"errorCode\": \"invalid_url\"")
    });
  });

  it("exposes a CLI guard for missing secret env vars without printing secret values", async () => {
    await expect(runCli([
      "checkout-issuance-smoke",
      "--url",
      "https://license.example/v1/admin/licenses/issue",
      "--release-version",
      "v1.0.0",
      "--checkout-lookup-key",
      "neondiff_monthly",
      "--provider-account-id",
      TEST_PROVIDER_TUPLE.providerAccountId,
      "--provider-mode",
      TEST_PROVIDER_TUPLE.providerMode,
      "--external-subscription-id",
      TEST_PROVIDER_TUPLE.externalSubscriptionId,
      "--external-checkout-id",
      TEST_PROVIDER_TUPLE.externalCheckoutId,
      "--secret-env",
      "NEONDIFF_TEST_ISSUANCE_KEY",
      "--dry-run",
      "false",
      "--confirm-live-issuance",
      "true"
    ])).rejects.toMatchObject({
      stdout: expect.stringContaining("\"errorCode\": \"missing_secret_env\"")
    });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_OPTIONS: "--experimental-sqlite",
      LICENSE_ISSUANCE_SECRET: "",
      NEONDIFF_TEST_ISSUANCE_KEY: ""
    },
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}
