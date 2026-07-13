import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CHECKOUT_LOOKUP_KEYS,
  checkoutPolicyFor,
  isCheckoutLookupKey,
  type CheckoutLookupKey,
  type CheckoutPolicy
} from "./checkout-policy.js";
import {
  canonicalSubscriptionLifecycleRequestHash,
  type ParsedSubscriptionLifecycleRequest,
  type RenewPaidSubscriptionLifecycleRequest
} from "./subscription-lifecycle.js";

const SCHEMA_VERSION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 250;
const MAX_BUSY_TIMEOUT_MS = 1_000;
const BOUND_CHECKOUT_INPUT_FIELDS = new Set([
  "idempotencyKey",
  "checkoutLookupKey",
  "binding"
]);
const BOUND_CHECKOUT_BINDING_FIELDS = new Set([
  "provider",
  "providerAccountId",
  "providerMode",
  "externalSubscriptionId",
  "externalCheckoutId"
]);

export type SchemaMigrationStep =
  | "transaction-started"
  | "core-schema-created"
  | "lifecycle-schema-created"
  | "schema-verified"
  | "version-set";

export interface LicenseStoreOptions {
  migrationHook?: (step: SchemaMigrationStep) => void;
  /** Server-owned clock. Checkout callers cannot override it per issuance. */
  now?: () => Date;
  busyTimeoutMs?: number;
}

interface SchemaObjectSignature {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

const CORE_SCHEMA = `
  create table licenses (
    license_key_hash text primary key,
    plan text not null,
    repo_visibility_scope text not null,
    private_repo_allowed integer not null default 1,
    update_entitlement integer not null default 0,
    seats integer not null default 1,
    expires_at text,
    status text not null default 'active',
    revocation_reason text,
    created_at text not null default (datetime('now'))
  );

  create table activations (
    license_key_hash text not null,
    machine_id text not null,
    repo text,
    activated_at text not null default (datetime('now')),
    last_seen_at text not null default (datetime('now')),
    primary key (license_key_hash, machine_id)
  );

  create table license_issuance_events (
    idempotency_key text primary key,
    license_key_hash text not null,
    request_hash text not null,
    source text,
    external_ref text,
    created_at text not null default (datetime('now')),
    foreign key (license_key_hash) references licenses(license_key_hash)
  );
`;

const LIFECYCLE_SCHEMA = `
  create table checkout_subscription_bindings (
    issuance_idempotency_key text primary key,
    license_key_hash text not null unique,
    provider text not null,
    provider_account_id text not null,
    provider_mode text not null,
    external_subscription_id text not null,
    external_checkout_id text not null,
    last_non_mutating_event_created_at integer,
    created_at text not null default (datetime('now')),
    unique (provider, provider_account_id, provider_mode, external_subscription_id),
    foreign key (issuance_idempotency_key) references license_issuance_events(idempotency_key),
    foreign key (license_key_hash) references licenses(license_key_hash)
  );

  create table license_subscription_lifecycle_events (
    event_id text primary key,
    issuance_idempotency_key text not null,
    license_key_hash text not null,
    external_subscription_id text not null,
    request_hash text not null,
    event_created_at integer not null,
    provider text not null,
    provider_account_id text not null,
    provider_mode text not null,
    provider_event_type text not null,
    command text not null,
    payment_reference_fingerprint text,
    normalized_transition text not null,
    result text not null,
    created_at text not null default (datetime('now')),
    foreign key (issuance_idempotency_key) references checkout_subscription_bindings(issuance_idempotency_key),
    foreign key (license_key_hash) references licenses(license_key_hash)
  );

  create index license_subscription_lifecycle_events_issuance_time_idx
    on license_subscription_lifecycle_events (issuance_idempotency_key, event_created_at);
`;

const LEGACY_SCHEMA_SIGNATURE = expectedSchemaSignature(CORE_SCHEMA);
const SCHEMA_V2_SIGNATURE = expectedSchemaSignature(`${CORE_SCHEMA}\n${LIFECYCLE_SCHEMA}`);

export type LicenseStatus = "active" | "revoked" | "expired";
export type RepoVisibilityScope = "public" | "private" | "all";

export interface LicenseRecord {
  licenseKeyHash: string;
  plan: string;
  repoVisibilityScope: RepoVisibilityScope;
  privateRepoAllowed: boolean;
  updateEntitlement: boolean;
  seats: number;
  expiresAt?: string;
  status: LicenseStatus;
  revocationReason?: string;
  createdAt: string;
}

export interface ActivationRecord {
  licenseKeyHash: string;
  machineId: string;
  repo?: string;
  activatedAt: string;
  lastSeenAt: string;
}

interface LicenseRow {
  license_key_hash: string;
  plan: string;
  repo_visibility_scope: string;
  private_repo_allowed: number;
  update_entitlement: number;
  seats: number;
  expires_at: string | null;
  status: string;
  revocation_reason: string | null;
  created_at: string;
}

interface ActivationRow {
  license_key_hash: string;
  machine_id: string;
  repo: string | null;
  activated_at: string;
  last_seen_at: string;
}

interface LicenseIssuanceRow {
  idempotency_key: string;
  license_key_hash: string;
  request_hash: string;
  source: string | null;
  external_ref: string | null;
  created_at: string;
}

interface CheckoutSubscriptionBindingRow {
  issuance_idempotency_key: string;
  license_key_hash: string;
  provider: string;
  provider_account_id: string;
  provider_mode: string;
  external_subscription_id: string;
  external_checkout_id: string;
  last_non_mutating_event_created_at: number | null;
  created_at: string;
}

interface SubscriptionLifecycleEventRow {
  event_id: string;
  issuance_idempotency_key: string;
  license_key_hash: string;
  external_subscription_id: string;
  request_hash: string;
  event_created_at: number;
  provider: string;
  provider_account_id: string;
  provider_mode: string;
  provider_event_type: string;
  command: string;
  payment_reference_fingerprint: string | null;
  normalized_transition: string;
  result: string;
  created_at: string;
}

/**
 * Deterministic at-rest identifier for a license key. Only the hash is ever
 * stored or logged; the raw key is printed once by the admin CLI at issuance
 * and otherwise never leaves the client.
 */
export function hashLicenseKey(rawKey: string): string {
  return createHash("sha256").update(rawKey.trim()).digest("hex");
}

/**
 * Generate a raw license key with the `nd_live_<random>` shape the client
 * fingerprints. The random segment is url-safe base64 so keys survive JSON and
 * shell round-trips without escaping.
 */
export function generateLicenseKey(): string {
  const random = randomBytes(24).toString("base64url");
  return ["nd", "live", random].join("_");
}

export interface IssueLicenseInput {
  plan: string;
  repoVisibilityScope: RepoVisibilityScope;
  privateRepoAllowed?: boolean;
  updateEntitlement?: boolean;
  seats?: number;
  expiresAt?: string;
}

export interface IssueIdempotentLicenseInput extends IssueLicenseInput {
  idempotencyKey: string;
  requestHash: string;
  source?: string;
  externalRef?: string;
}

export interface CheckoutSubscriptionBindingInput {
  readonly provider: "stripe";
  readonly providerAccountId: string;
  readonly providerMode: "test" | "live";
  readonly externalSubscriptionId: string;
  readonly externalCheckoutId: string;
}

export interface CheckoutSubscriptionBindingRecord extends CheckoutSubscriptionBindingInput {
  issuanceIdempotencyKey: string;
  licenseKeyHash: string;
  lastNonMutatingEventCreatedAt?: number;
  createdAt: string;
}

export interface IssueBoundCheckoutLicenseInput {
  idempotencyKey: string;
  checkoutLookupKey: CheckoutLookupKey;
  binding: CheckoutSubscriptionBindingInput;
}

export class CheckoutIssuanceConflictError extends Error {}
export class CheckoutIssuancePolicyError extends Error {}
export class CheckoutIssuanceTransientError extends Error {}

export class SubscriptionLifecycleNotFoundError extends Error {}
export class SubscriptionLifecycleConflictError extends Error {}
export class SubscriptionLifecyclePolicyError extends Error {}
export class SubscriptionLifecycleTerminalError extends Error {}
export class SubscriptionLifecycleTransientError extends Error {}
export class SubscriptionLifecycleUnsupportedCommandError extends Error {}

export interface SubscriptionLifecycleEntitlement {
  status: LicenseStatus;
  plan: string;
  seats: number;
  expiresAt: string;
}

export interface SubscriptionLifecycleApplyResult {
  status:
    | "updated"
    | "replayed"
    | "ignored_stale"
    | "payment_attention"
    | "terminally_revoked";
  replayed: boolean;
  entitlement: SubscriptionLifecycleEntitlement;
}

export class LicenseStore {
  private readonly db: DatabaseSync;
  private readonly now: () => Date;

  constructor(dbPath: string, options: LicenseStoreOptions = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.now = options.now ?? (() => new Date());
    this.db = new DatabaseSync(dbPath, { timeout: resolveBusyTimeout(options.busyTimeoutMs) });
    try {
      this.db.exec("pragma foreign_keys = on");
      this.ensureSchema(options);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private ensureSchema(options: LicenseStoreOptions): void {
    const version = this.readUserVersion();
    if (version === SCHEMA_VERSION) {
      this.verifySchemaV2();
      return;
    }
    if (version !== 0) {
      throw new Error(`unsupported license database schema version ${version}`);
    }

    const currentSignature = readSchemaSignature(this.db);
    const isEmpty = currentSignature.length === 0;
    const isLegacy = signaturesEqual(currentSignature, LEGACY_SCHEMA_SIGNATURE);
    if (!isEmpty && !isLegacy) {
      throw new Error("unknown non-empty schema at user_version 0");
    }

    this.db.exec("begin immediate");
    try {
      options.migrationHook?.("transaction-started");
      if (isEmpty) this.db.exec(CORE_SCHEMA);
      options.migrationHook?.("core-schema-created");
      this.db.exec(LIFECYCLE_SCHEMA);
      options.migrationHook?.("lifecycle-schema-created");
      this.verifySchemaV2();
      options.migrationHook?.("schema-verified");
      this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
      options.migrationHook?.("version-set");
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  private readUserVersion(): number {
    const row = this.db.prepare("pragma user_version").get() as { user_version: number };
    return Number(row.user_version);
  }

  private verifySchemaV2(): void {
    const actual = readSchemaSignature(this.db);
    if (!sameStrings(schemaObjectKeys(actual), schemaObjectKeys(SCHEMA_V2_SIGNATURE))) {
      throw new Error("license database schema v2 has unexpected objects");
    }
    if (!signaturesEqual(actual, SCHEMA_V2_SIGNATURE)) {
      throw new Error("license database schema v2 has unexpected constraints");
    }
  }

  close(): void {
    this.db.close();
  }

  /** Issue a new license: generates a raw key, stores only its hash. */
  issueLicense(input: IssueLicenseInput): { rawKey: string; record: LicenseRecord } {
    const rawKey = generateLicenseKey();
    return this.insertLicense(rawKey, input);
  }

  /**
   * Issue a checkout-backed license idempotently. The caller supplies a raw key
   * derived from its idempotency secret, so retries can return the same key
   * without storing raw license material in SQLite.
   */
  issueIdempotentLicense(
    rawKey: string,
    input: IssueIdempotentLicenseInput
  ): { rawKey: string; record: LicenseRecord; replayed: boolean } {
    const existing = this.getIssuanceEvent(input.idempotencyKey);
    if (existing) {
      if (existing.request_hash !== input.requestHash) {
        throw new Error("idempotency key was already used with different request data");
      }
      const licenseKeyHash = hashLicenseKey(rawKey);
      if (licenseKeyHash !== existing.license_key_hash) {
        throw new Error("idempotency key was issued with a different key derivation secret");
      }
      const record = this.getLicenseByHash(existing.license_key_hash);
      if (!record) throw new Error("idempotency key points to a missing license record");
      return { rawKey, record, replayed: true };
    }

    this.db.exec("begin immediate");
    try {
      const { record } = this.insertLicense(rawKey, input);
      this.db
        .prepare(
          `insert into license_issuance_events (
            idempotency_key, license_key_hash, request_hash, source, external_ref
          ) values (?, ?, ?, ?, ?)`
        )
        .run(
          input.idempotencyKey,
          record.licenseKeyHash,
          input.requestHash,
          input.source ?? null,
          input.externalRef ?? null
        );
      this.db.exec("commit");
      return { rawKey, record, replayed: false };
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /**
   * Issue and bind a checkout license in one write transaction. Existing
   * admin and release issuance continue through issueLicense and
   * issueIdempotentLicense; only checkout fulfillment uses this stricter path.
   */
  issueBoundCheckoutLicense(
    rawKey: string,
    input: IssueBoundCheckoutLicenseInput
  ): {
    rawKey: string;
    record: LicenseRecord;
    binding: CheckoutSubscriptionBindingRecord;
    replayed: boolean;
  } {
    const validatedInput = validateBoundCheckoutInput(input);
    const policy = checkoutPolicyFor(validatedInput.checkoutLookupKey);
    const requestHash = boundCheckoutRequestHash(validatedInput);
    const issuedAt = this.now();
    if (!Number.isFinite(issuedAt.getTime())) {
      throw new Error("license store clock returned an invalid date");
    }
    let transactionStarted = false;
    try {
      this.db.exec("begin immediate");
      transactionStarted = true;
      const existing = this.getIssuanceEvent(validatedInput.idempotencyKey);
      if (existing) {
        if (existing.source !== "checkout") {
          throw new CheckoutIssuanceConflictError("issuance reference is not checkout-owned");
        }
        const binding = this.getCheckoutSubscriptionBinding(validatedInput.idempotencyKey);
        if (!binding) {
          throw new CheckoutIssuanceConflictError("legacy checkout issuance is not bound");
        }
        const record = this.getLicenseByHash(existing.license_key_hash);
        if (!record) {
          throw new Error("issuance reference points to a missing license record");
        }
        validateStoredCheckoutEntitlement(record, policy, issuedAt);
        if (hashLicenseKey(rawKey) !== existing.license_key_hash) {
          throw new CheckoutIssuanceConflictError(
            "issuance reference was issued with a different key derivation secret"
          );
        }
        if (existing.request_hash !== requestHash) {
          throw new CheckoutIssuanceConflictError(
            "issuance reference was already used with different request data"
          );
        }
        if (!sameCheckoutBinding(binding, validatedInput.binding)) {
          throw new CheckoutIssuanceConflictError(
            "issuance reference was already used with different checkout correlation"
          );
        }
        this.db.exec("commit");
        return { rawKey, record, binding, replayed: true };
      }

      const expiresAt = new Date(
        issuedAt.getTime() + policy.trialDays * 24 * 60 * 60 * 1_000
      ).toISOString();
      const { record } = this.insertLicense(rawKey, {
        plan: policy.plan,
        repoVisibilityScope: policy.repoVisibilityScope,
        privateRepoAllowed: policy.privateRepoAllowed,
        updateEntitlement: policy.updateEntitlement,
        seats: policy.seats,
        expiresAt
      });
      this.db
        .prepare(
          `insert into license_issuance_events (
            idempotency_key, license_key_hash, request_hash, source, external_ref
          ) values (?, ?, ?, 'checkout', ?)`
        )
        .run(
          validatedInput.idempotencyKey,
          record.licenseKeyHash,
          requestHash,
          validatedInput.binding.externalCheckoutId
        );
      this.db
        .prepare(
          `insert into checkout_subscription_bindings (
            issuance_idempotency_key, license_key_hash, provider, provider_account_id,
            provider_mode, external_subscription_id, external_checkout_id
          ) values (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          validatedInput.idempotencyKey,
          record.licenseKeyHash,
          validatedInput.binding.provider,
          validatedInput.binding.providerAccountId,
          validatedInput.binding.providerMode,
          validatedInput.binding.externalSubscriptionId,
          validatedInput.binding.externalCheckoutId
        );
      const binding = this.getCheckoutSubscriptionBinding(validatedInput.idempotencyKey);
      if (!binding) throw new Error("checkout binding insert did not persist");
      this.db.exec("commit");
      return { rawKey, record, binding, replayed: false };
    } catch (error) {
      if (transactionStarted) this.db.exec("rollback");
      if (isSqliteBusy(error)) {
        throw new CheckoutIssuanceTransientError("checkout issuance storage is busy");
      }
      if (
        error instanceof Error &&
        error.message.includes("UNIQUE constraint failed: checkout_subscription_bindings")
      ) {
        throw new CheckoutIssuanceConflictError("checkout correlation is already bound");
      }
      throw error;
    }
  }

  /** Apply one checkout lifecycle event against its immutable issuance binding. */
  applyCheckoutSubscriptionLifecycle(
    input: ParsedSubscriptionLifecycleRequest
  ): SubscriptionLifecycleApplyResult {
    const appliedAt = this.now();
    if (!Number.isFinite(appliedAt.getTime())) {
      throw new SubscriptionLifecyclePolicyError("license store clock is invalid");
    }
    const requestHash = canonicalSubscriptionLifecycleRequestHash(input);
    let transactionStarted = false;
    try {
      this.db.exec("begin immediate");
      transactionStarted = true;

      const issuance = this.getIssuanceEvent(input.issuanceIdempotencyKey);
      if (!issuance || issuance.source !== "checkout") {
        throw new SubscriptionLifecycleNotFoundError("checkout subscription binding was not found");
      }
      const binding = this.getCheckoutSubscriptionBinding(input.issuanceIdempotencyKey);
      if (
        !binding ||
        binding.licenseKeyHash !== issuance.license_key_hash ||
        !sameLifecycleBinding(binding, input)
      ) {
        throw new SubscriptionLifecycleNotFoundError("checkout subscription binding was not found");
      }
      const record = this.getLicenseByHash(issuance.license_key_hash);
      if (!record) {
        throw new SubscriptionLifecycleNotFoundError("checkout subscription binding was not found");
      }

      const existingEvent = this.getSubscriptionLifecycleEvent(input.eventId);
      if (existingEvent) {
        if (existingEvent.request_hash !== requestHash) {
          throw new SubscriptionLifecycleConflictError(
            "subscription lifecycle event conflicts with an existing event"
          );
        }
        const replayedRecord = this.getLicenseByHash(existingEvent.license_key_hash);
        if (!replayedRecord) {
          throw new Error("subscription lifecycle event points to a missing license");
        }
        this.db.exec("commit");
        return lifecycleResult("replayed", true, replayedRecord);
      }

      if (record.status === "revoked") {
        throw new SubscriptionLifecycleTerminalError("subscription entitlement is terminal");
      }
      if (record.status !== "active" && record.status !== "expired") {
        throw new SubscriptionLifecyclePolicyError("subscription entitlement state is invalid");
      }

      let result: Exclude<SubscriptionLifecycleApplyResult["status"], "replayed">;
      switch (input.command) {
        case "renew_paid": {
          const incomingPeriodEnd = validatePaidPeriodEnd(input, record.plan, appliedAt);
          const storedPeriodEnd = record.expiresAt ? Date.parse(record.expiresAt) : Number.NaN;
          if (!Number.isFinite(storedPeriodEnd)) {
            throw new SubscriptionLifecyclePolicyError("subscription entitlement expiry is invalid");
          }
          const effectivePeriodEnd = Math.max(storedPeriodEnd, incomingPeriodEnd);
          this.db
            .prepare(
              `update licenses
               set expires_at = ?, status = 'active'
               where license_key_hash = ?`
            )
            .run(new Date(effectivePeriodEnd).toISOString(), record.licenseKeyHash);
          result = "updated";
          break;
        }
        case "reconcile":
        case "cancel_at_period_end":
        case "payment_attention": {
          const stale = isStaleNonMutatingEvent(
            input.eventCreatedAt,
            binding.lastNonMutatingEventCreatedAt
          );
          if (!stale) {
            this.db
              .prepare(
                `update checkout_subscription_bindings
                 set last_non_mutating_event_created_at = max(
                   coalesce(last_non_mutating_event_created_at, ?), ?
                 )
                 where issuance_idempotency_key = ?`
              )
              .run(
                input.eventCreatedAt,
                input.eventCreatedAt,
                input.issuanceIdempotencyKey
              );
          }
          result = stale
            ? "ignored_stale"
            : input.command === "payment_attention"
              ? "payment_attention"
              : "updated";
          break;
        }
        case "revoke":
          this.db
            .prepare(
              `update licenses
               set status = 'revoked', revocation_reason = ?
               where license_key_hash = ?`
            )
            .run(input.reason ?? null, record.licenseKeyHash);
          result = "terminally_revoked";
          break;
        default:
          throw new SubscriptionLifecycleUnsupportedCommandError(
            "subscription lifecycle command is not implemented"
          );
      }
      this.db
        .prepare(
          `insert into license_subscription_lifecycle_events (
            event_id, issuance_idempotency_key, license_key_hash,
            external_subscription_id, request_hash, event_created_at,
            provider, provider_account_id, provider_mode, provider_event_type,
            command, payment_reference_fingerprint, normalized_transition, result
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.eventId,
          input.issuanceIdempotencyKey,
          record.licenseKeyHash,
          input.externalSubscriptionId,
          requestHash,
          input.eventCreatedAt,
          input.provider,
          input.providerAccountId,
          input.providerMode,
          input.providerEventType,
          input.command,
          input.command === "renew_paid" ? input.paymentReferenceFingerprint : null,
          input.command,
          result
        );
      const updated = this.getLicenseByHash(record.licenseKeyHash);
      if (!updated) {
        throw new Error("subscription entitlement update did not persist");
      }
      this.db.exec("commit");
      return lifecycleResult(result, false, updated);
    } catch (error) {
      if (transactionStarted) this.db.exec("rollback");
      if (isSqliteBusy(error)) {
        throw new SubscriptionLifecycleTransientError(
          "subscription lifecycle storage is temporarily unavailable"
        );
      }
      throw error;
    }
  }

  private insertLicense(rawKey: string, input: IssueLicenseInput): { rawKey: string; record: LicenseRecord } {
    const licenseKeyHash = hashLicenseKey(rawKey);
    const seats = input.seats ?? 1;
    if (!Number.isInteger(seats) || seats < 1) throw new Error("seats must be a positive integer");
    const privateRepoAllowed = input.privateRepoAllowed ?? input.repoVisibilityScope !== "public";
    const updateEntitlement = input.updateEntitlement ?? false;
    this.db
      .prepare(
        `insert into licenses (
          license_key_hash, plan, repo_visibility_scope, private_repo_allowed,
          update_entitlement, seats, expires_at, status
        ) values (?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .run(
        licenseKeyHash,
        input.plan,
        input.repoVisibilityScope,
        privateRepoAllowed ? 1 : 0,
        updateEntitlement ? 1 : 0,
        seats,
        input.expiresAt ?? null
      );
    const record = this.getLicenseByHash(licenseKeyHash);
    if (!record) throw new Error("license insert did not persist");
    return { rawKey, record };
  }

  private getIssuanceEvent(idempotencyKey: string): LicenseIssuanceRow | undefined {
    return this.db
      .prepare("select * from license_issuance_events where idempotency_key = ?")
      .get(idempotencyKey) as LicenseIssuanceRow | undefined;
  }

  private getCheckoutSubscriptionBinding(
    idempotencyKey: string
  ): CheckoutSubscriptionBindingRecord | undefined {
    const row = this.db
      .prepare(
        "select * from checkout_subscription_bindings where issuance_idempotency_key = ?"
      )
      .get(idempotencyKey) as CheckoutSubscriptionBindingRow | undefined;
    return row ? mapCheckoutSubscriptionBinding(row) : undefined;
  }

  private getSubscriptionLifecycleEvent(
    eventId: string
  ): SubscriptionLifecycleEventRow | undefined {
    return this.db
      .prepare("select * from license_subscription_lifecycle_events where event_id = ?")
      .get(eventId) as SubscriptionLifecycleEventRow | undefined;
  }

  getLicenseByHash(licenseKeyHash: string): LicenseRecord | undefined {
    const row = this.db
      .prepare("select * from licenses where license_key_hash = ?")
      .get(licenseKeyHash) as LicenseRow | undefined;
    return row ? mapLicense(row) : undefined;
  }

  getLicenseByKey(rawKey: string): LicenseRecord | undefined {
    return this.getLicenseByHash(hashLicenseKey(rawKey));
  }

  listLicenses(): LicenseRecord[] {
    const rows = this.db
      .prepare("select * from licenses order by created_at asc")
      .all() as unknown as LicenseRow[];
    return rows.map(mapLicense);
  }

  /** Revoke a license by raw key. Returns false when the key is unknown. */
  revokeLicense(rawKey: string, reason?: string): boolean {
    const info = this.db
      .prepare("update licenses set status = 'revoked', revocation_reason = ? where license_key_hash = ?")
      .run(reason ?? null, hashLicenseKey(rawKey));
    return Number(info.changes) > 0;
  }

  getActivation(licenseKeyHash: string, machineId: string): ActivationRecord | undefined {
    const row = this.db
      .prepare("select * from activations where license_key_hash = ? and machine_id = ?")
      .get(licenseKeyHash, machineId) as ActivationRow | undefined;
    return row ? mapActivation(row) : undefined;
  }

  listActivations(licenseKeyHash: string): ActivationRecord[] {
    const rows = this.db
      .prepare("select * from activations where license_key_hash = ? order by activated_at asc")
      .all(licenseKeyHash) as unknown as ActivationRow[];
    return rows.map(mapActivation);
  }

  countActivations(licenseKeyHash: string): number {
    const row = this.db
      .prepare("select count(*) as n from activations where license_key_hash = ?")
      .get(licenseKeyHash) as { n: number };
    return Number(row.n);
  }

  /** Bind a machine to a license (insert) or refresh last_seen_at (idempotent). */
  upsertActivation(licenseKeyHash: string, machineId: string, repo: string | undefined, now: string): void {
    this.db
      .prepare(
        `insert into activations (license_key_hash, machine_id, repo, activated_at, last_seen_at)
         values (?, ?, ?, ?, ?)
         on conflict (license_key_hash, machine_id)
         do update set last_seen_at = excluded.last_seen_at, repo = coalesce(excluded.repo, activations.repo)`
      )
      .run(licenseKeyHash, machineId, repo ?? null, now, now);
  }

  touchActivation(licenseKeyHash: string, machineId: string, now: string): void {
    this.db
      .prepare("update activations set last_seen_at = ? where license_key_hash = ? and machine_id = ?")
      .run(now, licenseKeyHash, machineId);
  }

  /** Free a seat. Returns true when a row was deleted. */
  removeActivation(licenseKeyHash: string, machineId: string): boolean {
    const info = this.db
      .prepare("delete from activations where license_key_hash = ? and machine_id = ?")
      .run(licenseKeyHash, machineId);
    return Number(info.changes) > 0;
  }
}

function mapLicense(row: LicenseRow): LicenseRecord {
  return {
    licenseKeyHash: row.license_key_hash,
    plan: row.plan,
    repoVisibilityScope: row.repo_visibility_scope as RepoVisibilityScope,
    privateRepoAllowed: row.private_repo_allowed === 1,
    updateEntitlement: row.update_entitlement === 1,
    seats: row.seats,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    status: row.status as LicenseStatus,
    ...(row.revocation_reason ? { revocationReason: row.revocation_reason } : {}),
    createdAt: row.created_at
  };
}

function mapActivation(row: ActivationRow): ActivationRecord {
  return {
    licenseKeyHash: row.license_key_hash,
    machineId: row.machine_id,
    ...(row.repo ? { repo: row.repo } : {}),
    activatedAt: row.activated_at,
    lastSeenAt: row.last_seen_at
  };
}

function mapCheckoutSubscriptionBinding(
  row: CheckoutSubscriptionBindingRow
): CheckoutSubscriptionBindingRecord {
  if (row.provider !== "stripe") {
    throw new CheckoutIssuanceConflictError("checkout binding provider is unsupported");
  }
  if (row.provider_mode !== "test" && row.provider_mode !== "live") {
    throw new CheckoutIssuanceConflictError("checkout binding mode is unsupported");
  }
  return {
    issuanceIdempotencyKey: row.issuance_idempotency_key,
    licenseKeyHash: row.license_key_hash,
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    providerMode: row.provider_mode,
    externalSubscriptionId: row.external_subscription_id,
    externalCheckoutId: row.external_checkout_id,
    ...(row.last_non_mutating_event_created_at !== null
      ? { lastNonMutatingEventCreatedAt: row.last_non_mutating_event_created_at }
      : {}),
    createdAt: row.created_at
  };
}

function sameCheckoutBinding(
  existing: CheckoutSubscriptionBindingRecord,
  requested: CheckoutSubscriptionBindingInput
): boolean {
  return (
    existing.provider === requested.provider &&
    existing.providerAccountId === requested.providerAccountId &&
    existing.providerMode === requested.providerMode &&
    existing.externalSubscriptionId === requested.externalSubscriptionId &&
    existing.externalCheckoutId === requested.externalCheckoutId
  );
}

function sameLifecycleBinding(
  binding: CheckoutSubscriptionBindingRecord,
  request: ParsedSubscriptionLifecycleRequest
): boolean {
  return (
    binding.provider === request.provider &&
    binding.providerAccountId === request.providerAccountId &&
    binding.providerMode === request.providerMode &&
    binding.externalSubscriptionId === request.externalSubscriptionId
  );
}

function validatePaidPeriodEnd(
  request: RenewPaidSubscriptionLifecycleRequest,
  plan: string,
  now: Date
): number {
  const value = request.currentPeriodEnd;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new SubscriptionLifecyclePolicyError("paid period end is invalid");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds <= now.getTime()
  ) {
    throw new SubscriptionLifecyclePolicyError("paid period end is invalid");
  }
  const maximumPeriodDays = maximumPeriodDaysForPlan(plan);
  if (milliseconds > now.getTime() + maximumPeriodDays * 24 * 60 * 60 * 1_000) {
    throw new SubscriptionLifecyclePolicyError("paid period end exceeds the plan maximum");
  }
  return milliseconds;
}

function isStaleNonMutatingEvent(
  eventCreatedAt: number,
  lastEventCreatedAt: number | undefined
): boolean {
  // Provider seconds are not unique. Equal-second events are concurrent and
  // therefore all remain auditable non-stale updates; command precedence is
  // carried by terminal revoke, monotonic renewal, and audit-only updates.
  return lastEventCreatedAt !== undefined && eventCreatedAt < lastEventCreatedAt;
}

function maximumPeriodDaysForPlan(plan: string): number {
  for (const lookupKey of CHECKOUT_LOOKUP_KEYS) {
    const policy = checkoutPolicyFor(lookupKey);
    if (policy.plan === plan) return policy.maximumPeriodDays;
  }
  throw new SubscriptionLifecyclePolicyError("subscription entitlement plan is invalid");
}

function lifecycleResult(
  status: SubscriptionLifecycleApplyResult["status"],
  replayed: boolean,
  record: LicenseRecord
): SubscriptionLifecycleApplyResult {
  if (!record.expiresAt) {
    throw new SubscriptionLifecyclePolicyError("subscription entitlement expiry is invalid");
  }
  return {
    status,
    replayed,
    entitlement: {
      status: record.status,
      plan: record.plan,
      seats: record.seats,
      expiresAt: record.expiresAt
    }
  };
}

function resolveBusyTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_BUSY_TIMEOUT_MS) {
    throw new Error(`busyTimeoutMs must be an integer from 1 to ${MAX_BUSY_TIMEOUT_MS}`);
  }
  return timeout;
}

function validateBoundCheckoutInput(
  input: IssueBoundCheckoutLicenseInput
): IssueBoundCheckoutLicenseInput {
  for (const key of Object.keys(input)) {
    if (!BOUND_CHECKOUT_INPUT_FIELDS.has(key)) {
      throw new CheckoutIssuancePolicyError(`unsupported bound checkout field: ${key}`);
    }
  }
  for (const key of Object.keys(input.binding)) {
    if (!BOUND_CHECKOUT_BINDING_FIELDS.has(key)) {
      throw new CheckoutIssuancePolicyError(`unsupported checkout binding field: ${key}`);
    }
  }
  const idempotencyKey = readBoundedCheckoutString(input.idempotencyKey, "idempotencyKey", 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new CheckoutIssuancePolicyError("idempotencyKey contains unsupported characters");
  }
  const checkoutLookupKey = readBoundedCheckoutString(
    input.checkoutLookupKey,
    "checkoutLookupKey",
    80
  );
  if (!isCheckoutLookupKey(checkoutLookupKey)) {
    throw new CheckoutIssuancePolicyError(
      `checkoutLookupKey must be one of: ${CHECKOUT_LOOKUP_KEYS.join(", ")}`
    );
  }
  if (input.binding.provider !== "stripe") {
    throw new CheckoutIssuancePolicyError("provider must be stripe");
  }
  if (input.binding.providerMode !== "test" && input.binding.providerMode !== "live") {
    throw new CheckoutIssuancePolicyError("providerMode must be test or live");
  }
  return {
    idempotencyKey,
    checkoutLookupKey,
    binding: {
      provider: input.binding.provider,
      providerAccountId: readBoundedCheckoutString(
        input.binding.providerAccountId,
        "providerAccountId",
        160
      ),
      providerMode: input.binding.providerMode,
      externalSubscriptionId: readBoundedCheckoutString(
        input.binding.externalSubscriptionId,
        "externalSubscriptionId",
        160
      ),
      externalCheckoutId: readBoundedCheckoutString(
        input.binding.externalCheckoutId,
        "externalCheckoutId",
        160
      )
    }
  };
}

function readBoundedCheckoutString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CheckoutIssuancePolicyError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new CheckoutIssuancePolicyError(`${field} is too long`);
  }
  return trimmed;
}

function boundCheckoutRequestHash(input: IssueBoundCheckoutLicenseInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        checkoutLookupKey: input.checkoutLookupKey,
        provider: input.binding.provider,
        providerAccountId: input.binding.providerAccountId,
        providerMode: input.binding.providerMode,
        externalSubscriptionId: input.binding.externalSubscriptionId,
        externalCheckoutId: input.binding.externalCheckoutId
      })
    )
    .digest("hex");
}

function validateStoredCheckoutEntitlement(
  record: LicenseRecord,
  policy: CheckoutPolicy,
  now: Date
): void {
  if (
    record.plan !== policy.plan ||
    record.repoVisibilityScope !== policy.repoVisibilityScope ||
    record.privateRepoAllowed !== policy.privateRepoAllowed ||
    record.updateEntitlement !== policy.updateEntitlement ||
    record.seats !== policy.seats ||
    !record.expiresAt ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) {
    throw new CheckoutIssuanceConflictError(
      "checkout issuance entitlement does not match server policy"
    );
  }
  if (record.status !== "active" || Date.parse(record.expiresAt) <= now.getTime()) {
    throw new CheckoutIssuanceConflictError("checkout issuance is no longer usable");
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "ERR_SQLITE_ERROR" && /database is (?:locked|busy)/i.test(error.message);
}

function expectedSchemaSignature(schema: string): SchemaObjectSignature[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schema);
    return readSchemaSignature(db);
  } finally {
    db.close();
  }
}

function readSchemaSignature(db: DatabaseSync): SchemaObjectSignature[] {
  const rows = db
    .prepare(
      `select type, name, tbl_name, sql
       from sqlite_schema
       where name not like 'sqlite_%'
       order by type, name`
    )
    .all() as unknown as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  return rows.map((row) => ({
    type: row.type,
    name: row.name,
    tableName: row.tbl_name,
    sql: normalizeSchemaSql(row.sql)
  }));
}

function normalizeSchemaSql(sql: string): string {
  let result = "";
  let pendingSpace = false;
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    if (quote) {
      result += character;
      if (character === quote) {
        if (sql[index + 1] === quote) {
          result += quote;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (character === "'" || character === '"' || character === "`") {
      if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
      pendingSpace = false;
      quote = character;
      result += character;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (character === "(" || character === ")" || character === "," || character === ";") {
      result = result.trimEnd() + character;
      pendingSpace = false;
      continue;
    }
    if (pendingSpace && result && !result.endsWith("(") && !result.endsWith(",")) result += " ";
    pendingSpace = false;
    result += character.toLowerCase();
  }

  return result.trim().replace(/;$/, "");
}

function signaturesEqual(
  actual: readonly SchemaObjectSignature[],
  expected: readonly SchemaObjectSignature[]
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function schemaObjectKeys(signature: readonly SchemaObjectSignature[]): string[] {
  return signature.map((object) => `${object.type}:${object.name}:${object.tableName}`);
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}
