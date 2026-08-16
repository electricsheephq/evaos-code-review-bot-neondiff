import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  type LicenseConfig
} from "../src/license.js";
import { LicenseStore } from "../services/license-api/src/store.js";
import { createLicenseRequestListener } from "../services/license-api/src/http.js";
import {
  issueCheckoutLicense,
  type LicenseIssuanceRequest
} from "../services/license-api/src/issuance.js";
import { RateLimiter } from "../services/license-api/src/service.js";

/**
 * Load-bearing contract test (#327): drives the REAL shipped client
 * (`src/license.ts`) against the REAL license service (`services/license-api`)
 * through activate → validate → deactivate → reactivate-different-machine, and
 * asserts the client parses each outcome into the correct LicenseStatus. This
 * proves the HTTP contract the client already calls matches the service.
 *
 * The service and client run in-process: `fetchImpl` serializes the client's
 * request, feeds it to the service's request listener via a mock
 * IncomingMessage/ServerResponse pair, and returns the service's Response. It
 * also rewrites `machineId` so a single test process can play multiple
 * machines (the client hardcodes localMachineId()).
 */

interface MockService {
  fetchFor(machineId: string): typeof fetch;
  issueBoundKey(tag: string): string;
  setNow(now: Date): void;
}

const LIFECYCLE_ISSUANCE_SECRET = "test-only-contract-lifecycle-secret";
const LIFECYCLE_START = new Date("2026-07-13T00:00:00.000Z");

function buildInProcessService(root: string): { service: MockService; store: LicenseStore; issueKey: () => string; close: () => void } {
  let serviceNow = LIFECYCLE_START;
  const store = new LicenseStore(join(root, "license-service.sqlite"), {
    now: () => serviceNow
  });
  const listener = createLicenseRequestListener({
    store,
    issuanceSecret: LIFECYCLE_ISSUANCE_SECRET,
    now: () => serviceNow,
    // Generous limiter so the contract sequence is never throttled.
    rateLimiter: new RateLimiter({ maxPerWindow: 1000, windowMs: 60_000 })
  });

  const fetchFor = (machineId: string): typeof fetch => {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const originalBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // Play the requested machine regardless of the client's localMachineId().
      const body = JSON.stringify(
        path.startsWith("/v1/license/")
          ? { ...originalBody, machineId }
          : originalBody
      );

      return await new Promise<Response>((resolve) => {
        const chunks: Buffer[] = [];
        const req: any = {
          method: init?.method ?? "POST",
          url: path,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          socket: { remoteAddress: "127.0.0.1" },
          on(event: string, cb: (arg?: unknown) => void) {
            if (event === "data") cb(Buffer.from(body));
            if (event === "end") cb();
            return req;
          },
          destroy() {}
        };
        let statusCode = 200;
        let headers: Record<string, string> = {};
        const resChunks: string[] = [];
        const res: any = {
          writeHead(code: number, h: Record<string, string>) {
            statusCode = code;
            headers = h;
            return res;
          },
          end(payload?: string) {
            if (payload) resChunks.push(payload);
            resolve(new Response(resChunks.join(""), { status: statusCode, headers }));
          }
        };
        void listener(req, res);
      });
    }) as typeof fetch;
  };

  return {
    service: {
      fetchFor,
      issueBoundKey(tag: string): string {
        const request: LicenseIssuanceRequest = {
          idempotencyKey: `checkout-session:contract-${tag}`,
          checkoutLookupKey: "neondiff_monthly",
          provider: "stripe",
          providerAccountId: "acct_contract",
          providerMode: "live",
          externalSubscriptionId: `sub_contract_${tag}`,
          externalCheckoutId: `cs_contract_${tag}`
        };
        const result = issueCheckoutLicense(store, request, LIFECYCLE_ISSUANCE_SECRET);
        if (result.httpStatus !== 200) throw new Error("bound checkout issuance failed");
        return (result.body as { licenseKey: string }).licenseKey;
      },
      setNow(now: Date): void {
        serviceNow = now;
      }
    },
    store,
    issueKey: () => store.issueLicense({ plan: "yearly", repoVisibilityScope: "private", seats: 1 }).rawKey,
    close: () => store.close()
  };
}

function lifecycleRequest(
  tag: string,
  command: "renew_paid" | "cancel_at_period_end" | "revoke",
  eventCreatedAt: Date,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const variants = {
    renew_paid: {
      providerEventType: "invoice.paid",
      subscriptionStatus: "active",
      paymentReference: `in_contract_${tag}`,
      amountPaidMinor: 100,
      currency: "usd",
      paidOutOfBand: false,
      billingReason: "subscription_cycle",
      currentPeriodEnd: "2026-08-13T00:00:00.000Z",
      cancelAtPeriodEnd: false
    },
    cancel_at_period_end: {
      providerEventType: "customer.subscription.updated",
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-08-13T00:00:00.000Z",
      cancelAtPeriodEnd: true
    },
    revoke: {
      providerEventType: "customer.subscription.deleted",
      subscriptionStatus: "canceled",
      cancelAtPeriodEnd: false,
      reason: "subscription_canceled"
    }
  } as const;
  return {
    schemaVersion: 1,
    issuanceIdempotencyKey: `checkout-session:contract-${tag}`,
    eventId: `evt_contract_${tag}_${command}`,
    eventCreatedAt: Math.floor(eventCreatedAt.getTime() / 1_000),
    provider: "stripe",
    providerAccountId: "acct_contract",
    providerMode: "live",
    externalSubscriptionId: `sub_contract_${tag}`,
    command,
    ...variants[command],
    ...overrides
  };
}

async function applyLifecycle(
  service: MockService,
  body: Record<string, unknown>
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const response = await service.fetchFor("lifecycle-admin")(
    "http://127.0.0.1:8080/v1/admin/licenses/lifecycle",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LIFECYCLE_ISSUANCE_SECRET}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );
  const text = await response.text();
  return {
    status: response.status,
    text,
    json: JSON.parse(text) as Record<string, unknown>
  };
}

function expectLifecycleResponseRedacted(
  response: { text: string },
  rawKey: string,
  request: Record<string, unknown>
): void {
  const requestIdentifiers = [
    request.issuanceIdempotencyKey,
    request.eventId,
    request.provider,
    request.providerAccountId,
    request.providerMode,
    request.externalSubscriptionId,
    request.paymentReference
  ].filter((value): value is string => typeof value === "string");
  for (const forbidden of [
    rawKey,
    LIFECYCLE_ISSUANCE_SECRET,
    "cs_contract_",
    ...requestIdentifiers
  ]) {
    expect(response.text).not.toContain(forbidden);
  }
}

describe("client ↔ service contract (real src/license.ts against real service)", () => {
  const roots: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeConfig(root: string, apiBaseUrl: string): LicenseConfig {
    return {
      enabled: true,
      apiBaseUrl,
      cachePath: join(root, "entitlement.json"),
      storageBackend: "file",
      keyPath: join(root, "license.key"),
      keychainService: "neondiff-test",
      keychainAccount: "neondiff-test",
      requestTimeoutMs: 5_000,
      offlineGraceMs: 0,
      publicReposFree: true,
      privateReposRequireEntitlement: true,
      updateEntitlementRequiresLicense: false
    };
  }

  it("activate → validate → deactivate → reactivate-different-machine parses to correct LicenseStatus", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-contract-"));
    roots.push(root);
    const { service, issueKey, close } = buildInProcessService(root);
    closers.push(close);
    const config = makeConfig(root, "http://127.0.0.1:8080");
    const key = issueKey();

    // 1) activate on machine A → active
    const activated = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(activated.ok).toBe(true);
    expect(activated.status).toBe("active");
    expect(activated.entitlement?.repoVisibilityScope).toBe("private");
    expect(JSON.stringify(activated)).not.toContain(key);

    // 2) validate on machine A (hot path, refresh:true reads stored key) → active
    const validated = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(validated.ok).toBe(true);
    expect(validated.status).toBe("active");
    expect(validated.source).toBe("api");

    // 3) deactivate machine A (notify the API) → seat freed
    const deactivated = await deactivateLicense({
      config,
      notifyApi: true,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(deactivated.ok).toBe(true);
    expect(deactivated.status).toBe("deactivated");
    expect(deactivated.apiNotified).toBe(true);

    // Re-activate machine A first so the single seat is taken again...
    const reactivatedA = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(reactivatedA.status).toBe("active");

    // 4) reactivate on a DIFFERENT machine while the seat is exhausted → scope_mismatch
    const reactivatedB = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      fetchImpl: service.fetchFor("machine-b")
    });
    expect(reactivatedB.ok).toBe(false);
    expect(reactivatedB.status).toBe("scope_mismatch");
    expect(reactivatedB.classification).toBe("scope_mismatch");
    expect(JSON.stringify(reactivatedB)).not.toContain(key);
  });

  it("client maps revoked and expired denials through the real service", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-contract-"));
    roots.push(root);
    const { service, store, issueKey, close } = buildInProcessService(root);
    closers.push(close);
    const config = makeConfig(root, "http://127.0.0.1:8080");

    // revoked → client status "revoked"
    const revokedKey = issueKey();
    await activateLicense({ config, licenseKey: revokedKey, fetchImpl: service.fetchFor("machine-a") });
    store.revokeLicense(revokedKey, "refund");
    const revoked = await getLicenseStatus({ config, refresh: true, fetchImpl: service.fetchFor("machine-a") });
    expect(revoked.status).toBe("revoked");

    // unknown key → client status "invalid"
    const unknown = await activateLicense({
      config: makeConfig(mkdtempSync(join(tmpdir(), "nd-contract-")), "http://127.0.0.1:8080"),
      licenseKey: ["nd", "live", `unknown${"x".repeat(17)}`].join("_"),
      fetchImpl: service.fetchFor("machine-z")
    });
    expect(unknown.status).toBe("invalid");
  });

  it("keeps the v1.0.4 client active through paid renewal and cancellation, then expires at paid end", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-contract-lifecycle-"));
    roots.push(root);
    const { service, close } = buildInProcessService(root);
    closers.push(close);
    const config = makeConfig(root, "http://127.0.0.1:8080");
    const key = service.issueBoundKey("renew-cancel");
    const lifecycleEvidence: string[] = [];

    const activated = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      now: LIFECYCLE_START,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(activated.status).toBe("active");
    expect(JSON.stringify(activated)).not.toContain(key);

    const renewalRequest = lifecycleRequest("renew-cancel", "renew_paid", LIFECYCLE_START);
    const renewed = await applyLifecycle(service, renewalRequest);
    lifecycleEvidence.push(renewed.text);
    expect(renewed.status).toBe(200);
    expect(renewed.json.status).toBe("updated");
    expectLifecycleResponseRedacted(renewed, key, renewalRequest);

    const activeAfterRenewal = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: LIFECYCLE_START,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(activeAfterRenewal.status).toBe("active");

    const cancellationTime = new Date("2026-07-14T00:00:00.000Z");
    service.setNow(cancellationTime);
    const cancellationRequest = lifecycleRequest(
      "renew-cancel",
      "cancel_at_period_end",
      cancellationTime
    );
    const cancelled = await applyLifecycle(service, cancellationRequest);
    lifecycleEvidence.push(cancelled.text);
    expect(cancelled.status).toBe(200);
    expect(cancelled.json.status).toBe("updated");
    expectLifecycleResponseRedacted(cancelled, key, cancellationRequest);

    const activeAfterCancellation = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: cancellationTime,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(activeAfterCancellation.status).toBe("active");

    const afterOriginalTrialTime = new Date("2026-07-21T00:00:00.000Z");
    service.setNow(afterOriginalTrialTime);
    const activeAfterOriginalTrial = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: afterOriginalTrialTime,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(activeAfterOriginalTrial.status).toBe("active");

    const paidEndTime = new Date("2026-08-13T00:00:01.000Z");
    service.setNow(paidEndTime);
    const expired = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: paidEndTime,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(expired.status).toBe("expired");
    expect(JSON.stringify(expired)).not.toContain(key);
    expect(lifecycleEvidence.join("\n")).not.toContain(key);
  });

  it("keeps a terminally revoked entitlement revoked when a later paid renewal arrives", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-contract-lifecycle-"));
    roots.push(root);
    const { service, close } = buildInProcessService(root);
    closers.push(close);
    const config = makeConfig(root, "http://127.0.0.1:8080");
    const key = service.issueBoundKey("revoke");

    const activated = await activateLicense({
      config,
      licenseKey: key,
      now: LIFECYCLE_START,
      fetchImpl: service.fetchFor("machine-r")
    });
    expect(activated.status).toBe("active");

    const revocationRequest = lifecycleRequest("revoke", "revoke", LIFECYCLE_START);
    const revokedResponse = await applyLifecycle(service, revocationRequest);
    expect(revokedResponse.status).toBe(200);
    expect(revokedResponse.json.status).toBe("terminally_revoked");
    expectLifecycleResponseRedacted(revokedResponse, key, revocationRequest);

    const revoked = await getLicenseStatus({
      config,
      refresh: true,
      now: LIFECYCLE_START,
      fetchImpl: service.fetchFor("machine-r")
    });
    expect(revoked.status).toBe("revoked");
    expect(JSON.stringify(revoked)).not.toContain(key);

    const laterRenewalRequest = lifecycleRequest(
      "revoke",
      "renew_paid",
      new Date(LIFECYCLE_START.getTime() + 60_000),
      {
        eventId: "evt_contract_revoke_later_renew_paid"
      }
    );
    const laterRenewal = await applyLifecycle(service, laterRenewalRequest);
    expect(laterRenewal.status, laterRenewal.text).toBe(409);
    expect(laterRenewal.json).toEqual({ status: "terminally_revoked" });
    expectLifecycleResponseRedacted(laterRenewal, key, laterRenewalRequest);

    const stillRevoked = await getLicenseStatus({
      config,
      refresh: true,
      now: LIFECYCLE_START,
      fetchImpl: service.fetchFor("machine-r")
    });
    expect(stillRevoked.status).toBe("revoked");
    expect(JSON.stringify(stillRevoked)).not.toContain(key);
  });
});
