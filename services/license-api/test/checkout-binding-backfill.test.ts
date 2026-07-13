import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LicenseStore } from "../src/store.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "neondiff-checkout-backfill-"));
  tempDirectories.push(directory);
  return join(directory, "license.sqlite");
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuanceIdempotencyKey: "checkout-session:legacy-backfill",
    provider: "stripe",
    providerAccountId: "acct_product_live",
    providerMode: "live",
    externalSubscriptionId: "sub_legacy_backfill",
    externalCheckoutId: "cs_legacy_backfill",
    ...overrides
  };
}

function issueLegacyCheckout(
  store: LicenseStore,
  source = "checkout",
  idempotencyKey = "checkout-session:legacy-backfill",
  rawKey = "nd_live_legacybackfillrawmaterial"
): void {
  store.issueIdempotentLicense(rawKey, {
    idempotencyKey,
    requestHash: `legacy-request-hash:${idempotencyKey}`,
    source,
    externalRef: "legacy-checkout-reference",
    plan: "monthly_support",
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    updateEntitlement: true,
    seats: 1,
    expiresAt: "2026-08-13T00:00:00.000Z"
  });
}

function bind(store: LicenseStore, input = binding(), dryRun = false): Record<string, unknown> {
  return (
    store as unknown as {
      bindCheckoutSubscription(
        input: Record<string, unknown>,
        options?: { dryRun?: boolean }
      ): Record<string, unknown>;
    }
  ).bindCheckoutSubscription(input, { dryRun });
}

function bindingCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return Number(
      (db.prepare("select count(*) as count from checkout_subscription_bindings").get() as {
        count: number;
      }).count
    );
  } finally {
    db.close();
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "";
}

interface WorkerOutcome {
  type: "result" | "error";
  result?: string;
  errorName?: string;
}

function startBindingWorker(
  path: string,
  input: Record<string, unknown>
): {
  child: ChildProcess;
  ready: Promise<boolean>;
  completion: Promise<WorkerOutcome>;
} {
  const child = fork(new URL("./fixtures/checkout-binding-worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      CHECKOUT_BINDING_DB_PATH: path,
      CHECKOUT_BINDING_INPUT: JSON.stringify(input)
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"]
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  let readyResolve!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    readyResolve = resolve;
  });
  let completionResolve!: (outcome: WorkerOutcome) => void;
  let completionReject!: (error: Error) => void;
  const completion = new Promise<WorkerOutcome>((resolve, reject) => {
    completionResolve = resolve;
    completionReject = reject;
  });
  let readySettled = false;
  let readyReceived = false;
  let outcome: WorkerOutcome | undefined;
  let failure: Error | undefined;

  const settleReady = (value: boolean): void => {
    if (readySettled) return;
    readySettled = true;
    readyResolve(value);
  };
  const failAndKill = (error: Error): void => {
    failure ??= error;
    settleReady(false);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const timeout = setTimeout(() => {
    failAndKill(
      new Error(`checkout binding worker timed out${stderr ? `: ${stderr}` : ""}`)
    );
  }, 5_000);
  child.on("message", (message: unknown) => {
    const value = message as WorkerOutcome & { type: string; storeOpened?: boolean };
    if (value.type === "ready") {
      if (readyReceived || value.storeOpened !== true) {
        failAndKill(new Error("checkout binding worker READY before store opened"));
        return;
      }
      readyReceived = true;
      settleReady(true);
    } else if (value.type === "result" || value.type === "error") {
      if (!readyReceived || outcome) {
        failAndKill(new Error("checkout binding worker sent an invalid outcome"));
        return;
      }
      outcome = value;
    } else {
      failAndKill(new Error("checkout binding worker sent an invalid protocol message"));
    }
  });
  child.on("error", (error) => {
    failAndKill(error);
  });
  child.on("exit", (code, signal) => {
    clearTimeout(timeout);
    settleReady(false);
    if (
      failure ||
      code !== 0 ||
      signal !== null ||
      stderr.length > 0 ||
      !readyReceived ||
      !outcome
    ) {
      const details = [
        `checkout binding worker exited ${code ?? signal}`,
        !readyReceived ? "without READY" : "",
        !outcome ? "without outcome" : "",
        stderr ? `stderr: ${stderr}` : ""
      ].filter(Boolean).join("; ");
      completionReject(failure ?? new Error(details));
      return;
    }
    completionResolve(outcome);
  });
  return { child, ready, completion };
}

async function concurrentBindings(
  path: string,
  firstInput: Record<string, unknown>,
  secondInput: Record<string, unknown>
): Promise<WorkerOutcome[]> {
  const first = startBindingWorker(path, firstInput);
  const second = startBindingWorker(path, secondInput);
  const workers = [first, second];
  const completions = Promise.allSettled(workers.map((worker) => worker.completion));
  try {
    const ready = await Promise.all(workers.map((worker) => worker.ready));
    if (!ready.every(Boolean)) {
      const settled = await completions;
      const failure = settled.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      throw failure?.reason ?? new Error("checkout binding worker exited before READY");
    }
    first.child.send("GO");
    second.child.send("GO");
    const settled = await completions;
    const failure = settled.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    if (failure) throw failure.reason;
    return settled.map((result) => (result as PromiseFulfilledResult<WorkerOutcome>).value);
  } finally {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (child.connected) child.disconnect();
    }
    await completions;
  }
}

describe("checkout subscription binding backfill store", () => {
  it("dry-runs an existing checkout issuance with zero writes", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      issueLegacyCheckout(store);
      const result = bind(store, binding(), true);

      assert.equal(result.result, "would_bind");
      assert.match(String(result.issuanceFingerprint), /^iss_[a-f0-9]{32}$/);
      assert.equal(bindingCount(path), 0);
    } finally {
      store.close();
    }
  });

  it("rejects legacy entitlements that the subscription lifecycle cannot project", () => {
    for (const [label, overrides] of [
      ["missing expiry", { expiresAt: undefined }],
      ["invalid expiry", { expiresAt: "not-a-timestamp" }],
      ["unsupported plan", { plan: "legacy_lifetime" }],
      ["multiple seats", { seats: 2 }],
      ["public scope", { repoVisibilityScope: "public" }],
      ["private repositories disabled", { privateRepoAllowed: false }],
      ["updates disabled", { updateEntitlement: false }]
    ] as const) {
      const path = databasePath();
      const store = new LicenseStore(path);
      try {
        store.issueIdempotentLicense(`nd_live_${label.replaceAll(" ", "")}`, {
          idempotencyKey: "checkout-session:legacy-backfill",
          requestHash: `legacy-request-hash:${label}`,
          source: "checkout",
          externalRef: "legacy-checkout-reference",
          plan: "monthly_support",
          repoVisibilityScope: "private",
          privateRepoAllowed: true,
          updateEntitlement: true,
          seats: 1,
          expiresAt: "2026-08-13T00:00:00.000Z",
          ...overrides
        });

        assert.throws(
          () => bind(store),
          (error: unknown) => errorName(error) === "CheckoutBindingConflictError",
          label
        );
        assert.equal(bindingCount(path), 0, label);
      } finally {
        store.close();
      }
    }
  });

  it("binds once and makes identical replay idempotent across store connections", () => {
    const path = databasePath();
    const first = new LicenseStore(path);
    const second = new LicenseStore(path);
    try {
      issueLegacyCheckout(first);
      const created = bind(first);
      const replayed = bind(second);

      assert.equal(created.result, "bound");
      assert.equal(replayed.result, "already_bound");
      assert.equal(replayed.issuanceFingerprint, created.issuanceFingerprint);
      assert.equal(bindingCount(path), 1);
    } finally {
      second.close();
      first.close();
    }
  });

  it("conflicts when any immutable tuple field differs", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      issueLegacyCheckout(store);
      bind(store);
      for (const changed of [
        { providerAccountId: "acct_other" },
        { providerMode: "test" },
        { externalSubscriptionId: "sub_other" },
        { externalCheckoutId: "cs_other" }
      ]) {
        assert.throws(
          () => bind(store, binding(changed)),
          (error: unknown) => errorName(error) === "CheckoutBindingConflictError"
        );
      }
      assert.equal(bindingCount(path), 1);
    } finally {
      store.close();
    }
  });

  it("conflicts without overwrite when a second real issuance claims the same unique tuple", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      issueLegacyCheckout(store);
      issueLegacyCheckout(
        store,
        "checkout",
        "checkout-session:second-legacy-backfill",
        "nd_live_secondlegacybackfillraw"
      );
      bind(store);
      const second = binding({
        issuanceIdempotencyKey: "checkout-session:second-legacy-backfill"
      });

      assert.throws(
        () => bind(store, second),
        (error: unknown) => errorName(error) === "CheckoutBindingConflictError"
      );
      const db = new DatabaseSync(path);
      try {
        const rows = db
          .prepare(
            `select issuance_idempotency_key, external_subscription_id
             from checkout_subscription_bindings`
          )
          .all() as unknown as Array<Record<string, unknown>>;
        assert.deepEqual(rows.map((row) => ({ ...row })), [{
          issuance_idempotency_key: "checkout-session:legacy-backfill",
          external_subscription_id: "sub_legacy_backfill"
        }]);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it("conflicts without overwrite when issuance and binding point to different real licenses", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      issueLegacyCheckout(store);
      issueLegacyCheckout(
        store,
        "checkout",
        "checkout-session:other-real-license",
        "nd_live_otherreallicensebackfillraw"
      );
      bind(store);
      const db = new DatabaseSync(path);
      try {
        db.exec("pragma foreign_keys = off");
        db.prepare(
          `update license_issuance_events
           set license_key_hash = (
             select license_key_hash from license_issuance_events where idempotency_key = ?
           )
           where idempotency_key = ?`
        ).run("checkout-session:other-real-license", "checkout-session:legacy-backfill");
      } finally {
        db.close();
      }

      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingConflictError"
      );
      const verification = new DatabaseSync(path);
      try {
        const row = verification
          .prepare(
            `select issuance_idempotency_key, license_key_hash
             from checkout_subscription_bindings`
          )
          .get() as Record<string, unknown>;
        assert.equal(row.issuance_idempotency_key, "checkout-session:legacy-backfill");
        assert.notEqual(
          row.license_key_hash,
          store.getLicenseByKey("nd_live_otherreallicensebackfillraw")!.licenseKeyHash
        );
      } finally {
        verification.close();
      }
    } finally {
      store.close();
    }
  });

  it("serializes genuinely concurrent identical attempts to bound and already_bound", async () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    issueLegacyCheckout(store);
    store.close();

    const outcomes = await concurrentBindings(path, binding(), binding());
    assert.deepEqual(
      outcomes.map((outcome) => outcome.result ?? outcome.errorName).sort(),
      ["already_bound", "bound"]
    );
    assert.equal(bindingCount(path), 1);
  });

  it("serializes genuinely concurrent competing tuples to bound and typed conflict", async () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    issueLegacyCheckout(store);
    const licenseKeyHash = store.getLicenseByKey("nd_live_legacybackfillrawmaterial")!
      .licenseKeyHash;
    store.close();

    const firstInput = binding();
    const secondInput = binding({ externalSubscriptionId: "sub_competing_backfill" });
    const outcomes = await concurrentBindings(
      path,
      firstInput,
      secondInput
    );
    assert.deepEqual(
      outcomes.map((outcome) => outcome.result ?? outcome.errorName).sort(),
      ["CheckoutBindingConflictError", "bound"]
    );
    const db = new DatabaseSync(path);
    try {
      const rows = db.prepare(
        `select issuance_idempotency_key, license_key_hash, provider, provider_account_id,
                provider_mode, external_subscription_id, external_checkout_id
         from checkout_subscription_bindings`
      ).all() as unknown as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      const persisted = { ...rows[0] };
      const candidates = [firstInput, secondInput].map((candidate) => ({
        issuance_idempotency_key: candidate.issuanceIdempotencyKey,
        license_key_hash: licenseKeyHash,
        provider: candidate.provider,
        provider_account_id: candidate.providerAccountId,
        provider_mode: candidate.providerMode,
        external_subscription_id: candidate.externalSubscriptionId,
        external_checkout_id: candidate.externalCheckoutId
      }));
      assert.ok(
        candidates.some((candidate) => {
          try {
            assert.deepEqual(persisted, candidate);
            return true;
          } catch {
            return false;
          }
        }),
        "persisted binding must equal one complete competing tuple"
      );
    } finally {
      db.close();
    }
  });

  it("classifies missing issuance, wrong source, and missing license separately", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingNotFoundError"
      );
      issueLegacyCheckout(store, "admin");
      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingWrongSourceError"
      );
      store.close();

      const db = new DatabaseSync(path);
      db.exec("pragma foreign_keys = off");
      db.prepare("update license_issuance_events set source = 'checkout'").run();
      db.prepare("delete from licenses").run();
      db.close();

      const orphaned = new LicenseStore(path);
      try {
        assert.throws(
          () => bind(orphaned),
          (error: unknown) => errorName(error) === "CheckoutBindingNotFoundError"
        );
      } finally {
        orphaned.close();
      }
    } finally {
      try {
        store.close();
      } catch {}
    }
  });

  it("validates direct-store input and rejects escalation fields", () => {
    const store = new LicenseStore(":memory:");
    try {
      issueLegacyCheckout(store);
      for (const input of [
        binding({ rawKey: "nd_live_forbidden" }),
        binding({ plan: "organization_support" }),
        binding({ expiresAt: "2099-01-01T00:00:00.000Z" }),
        binding({ seats: 99 }),
        binding({ scope: "all" }),
        binding({ ownership: "caller" }),
        binding({ repoVisibilityScope: "all" }),
        binding({ privateRepoAllowed: true }),
        binding({ updateEntitlement: true }),
        binding({ provider: "other" }),
        binding({ providerMode: "staging" })
      ]) {
        assert.throws(
          () => bind(store, input),
          (error: unknown) => errorName(error) === "CheckoutBindingPolicyError"
        );
      }
    } finally {
      store.close();
    }
  });

  it("does not echo caller-controlled unknown field or option names", () => {
    const store = new LicenseStore(":memory:");
    try {
      issueLegacyCheckout(store);
      const fieldSentinel = "private_customer_field_sentinel";
      const optionSentinel = "private_customer_option_sentinel";
      assert.throws(
        () => bind(store, binding({ [fieldSentinel]: "value" })),
        (error: unknown) =>
          errorName(error) === "CheckoutBindingPolicyError" &&
          error instanceof Error &&
          error.message === "unsupported checkout binding field" &&
          !error.message.includes(fieldSentinel)
      );
      assert.throws(
        () => (
          store as unknown as {
            bindCheckoutSubscription(
              input: Record<string, unknown>,
              options: Record<string, unknown>
            ): unknown;
          }
        ).bindCheckoutSubscription(binding(), { [optionSentinel]: true }),
        (error: unknown) =>
          errorName(error) === "CheckoutBindingPolicyError" &&
          error instanceof Error &&
          error.message === "unsupported checkout binding option" &&
          !error.message.includes(optionSentinel)
      );
    } finally {
      store.close();
    }
  });

  it("bounds write-lock contention and persists no binding", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { busyTimeoutMs: 25 });
    const blocker = new DatabaseSync(path);
    try {
      issueLegacyCheckout(store);
      blocker.exec("begin immediate");
      const startedAt = Date.now();
      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingTransientError"
      );
      assert.ok(Date.now() - startedAt < 1_000);
      blocker.exec("rollback");
      assert.equal(bindingCount(path), 0);
    } finally {
      try {
        blocker.exec("rollback");
      } catch {}
      blocker.close();
      store.close();
    }
  });
});
