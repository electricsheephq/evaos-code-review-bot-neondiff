import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 2;

export type SchemaMigrationStep =
  | "transaction-started"
  | "core-schema-created"
  | "lifecycle-schema-created"
  | "schema-verified"
  | "version-set";

export interface LicenseStoreOptions {
  migrationHook?: (step: SchemaMigrationStep) => void;
}

interface TableColumn {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
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

const EXPECTED_COLUMNS: Record<string, readonly TableColumn[]> = {
  licenses: [
    column("license_key_hash", "TEXT", 0, null, 1),
    column("plan", "TEXT", 1),
    column("repo_visibility_scope", "TEXT", 1),
    column("private_repo_allowed", "INTEGER", 1, "1"),
    column("update_entitlement", "INTEGER", 1, "0"),
    column("seats", "INTEGER", 1, "1"),
    column("expires_at", "TEXT", 0),
    column("status", "TEXT", 1, "'active'"),
    column("revocation_reason", "TEXT", 0),
    column("created_at", "TEXT", 1, "datetime('now')")
  ],
  activations: [
    column("license_key_hash", "TEXT", 1, null, 1),
    column("machine_id", "TEXT", 1, null, 2),
    column("repo", "TEXT", 0),
    column("activated_at", "TEXT", 1, "datetime('now')"),
    column("last_seen_at", "TEXT", 1, "datetime('now')")
  ],
  license_issuance_events: [
    column("idempotency_key", "TEXT", 0, null, 1),
    column("license_key_hash", "TEXT", 1),
    column("request_hash", "TEXT", 1),
    column("source", "TEXT", 0),
    column("external_ref", "TEXT", 0),
    column("created_at", "TEXT", 1, "datetime('now')")
  ],
  checkout_subscription_bindings: [
    column("issuance_idempotency_key", "TEXT", 0, null, 1),
    column("license_key_hash", "TEXT", 1),
    column("provider", "TEXT", 1),
    column("provider_account_id", "TEXT", 1),
    column("provider_mode", "TEXT", 1),
    column("external_subscription_id", "TEXT", 1),
    column("external_checkout_id", "TEXT", 1),
    column("last_non_mutating_event_created_at", "INTEGER", 0),
    column("created_at", "TEXT", 1, "datetime('now')")
  ],
  license_subscription_lifecycle_events: [
    column("event_id", "TEXT", 0, null, 1),
    column("issuance_idempotency_key", "TEXT", 1),
    column("license_key_hash", "TEXT", 1),
    column("external_subscription_id", "TEXT", 1),
    column("request_hash", "TEXT", 1),
    column("event_created_at", "INTEGER", 1),
    column("provider", "TEXT", 1),
    column("provider_account_id", "TEXT", 1),
    column("provider_mode", "TEXT", 1),
    column("provider_event_type", "TEXT", 1),
    column("command", "TEXT", 1),
    column("payment_reference_fingerprint", "TEXT", 0),
    column("normalized_transition", "TEXT", 1),
    column("result", "TEXT", 1),
    column("created_at", "TEXT", 1, "datetime('now')")
  ]
};

function column(
  name: string,
  type: string,
  notnull: number,
  dflt_value: string | null = null,
  pk = 0
): TableColumn {
  return { name, type, notnull, dflt_value, pk };
}

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

export class LicenseStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string, options: LicenseStoreOptions = {}) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
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

    const tableNames = this.schemaObjectNames("table");
    const isEmpty = tableNames.length === 0;
    const isLegacy = this.isExactLegacySchema();
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

  private schemaObjectNames(type: "table" | "index" | "trigger" | "view"): string[] {
    return (
      this.db
        .prepare("select name from sqlite_schema where type = ? and name not like 'sqlite_%' order by name")
        .all(type) as unknown as Array<{ name: string }>
    ).map(({ name }) => name);
  }

  private isExactLegacySchema(): boolean {
    const legacyTables = ["activations", "license_issuance_events", "licenses"];
    if (!sameStrings(this.schemaObjectNames("table"), legacyTables)) return false;
    if (this.schemaObjectNames("index").length > 0) return false;
    if (this.schemaObjectNames("trigger").length > 0) return false;
    if (this.schemaObjectNames("view").length > 0) return false;
    if (!legacyTables.every((table) => this.hasExpectedColumns(table))) return false;

    const issuanceForeignKeys = this.foreignKeys("license_issuance_events");
    if (
      issuanceForeignKeys.length !== 1 ||
      issuanceForeignKeys[0]?.table !== "licenses" ||
      issuanceForeignKeys[0]?.from !== "license_key_hash" ||
      issuanceForeignKeys[0]?.to !== "license_key_hash"
    ) {
      return false;
    }
    return this.foreignKeys("licenses").length === 0 && this.foreignKeys("activations").length === 0;
  }

  private hasExpectedColumns(table: string): boolean {
    const actual = this.db.prepare(`pragma table_info(${table})`).all() as unknown as TableColumn[];
    return JSON.stringify(actual.map(normalizeColumn)) === JSON.stringify(EXPECTED_COLUMNS[table]);
  }

  private foreignKeys(table: string): ForeignKeyRow[] {
    return this.db.prepare(`pragma foreign_key_list(${table})`).all() as unknown as ForeignKeyRow[];
  }

  private uniqueColumnSets(table: string): string[] {
    const indexes = this.db.prepare(`pragma index_list(${table})`).all() as unknown as Array<{
      name: string;
      unique: number;
    }>;
    return indexes
      .filter((index) => index.unique === 1)
      .map((index) => {
        const columns = this.db.prepare(`pragma index_info(${index.name})`).all() as unknown as Array<{ name: string }>;
        return columns.map(({ name }) => name).join(",");
      })
      .sort();
  }

  private verifySchemaV2(): void {
    const expectedTables = [
      "activations",
      "checkout_subscription_bindings",
      "license_issuance_events",
      "license_subscription_lifecycle_events",
      "licenses"
    ];
    if (!sameStrings(this.schemaObjectNames("table"), expectedTables)) {
      throw new Error("license database schema v2 has unexpected tables");
    }
    if (!expectedTables.every((table) => this.hasExpectedColumns(table))) {
      throw new Error("license database schema v2 has unexpected columns");
    }
    const indexes = this.schemaObjectNames("index");
    if (!sameStrings(indexes, ["license_subscription_lifecycle_events_issuance_time_idx"])) {
      throw new Error("license database schema v2 has unexpected indexes");
    }

    const indexColumns = (
      this.db
        .prepare("pragma index_info(license_subscription_lifecycle_events_issuance_time_idx)")
        .all() as unknown as Array<{ name: string }>
    ).map(({ name }) => name);
    if (!sameStrings(indexColumns, ["issuance_idempotency_key", "event_created_at"])) {
      throw new Error("license database schema v2 has an invalid lifecycle index");
    }

    const bindingForeignKeys = foreignKeySignatures(this.foreignKeys("checkout_subscription_bindings"));
    const lifecycleForeignKeys = foreignKeySignatures(this.foreignKeys("license_subscription_lifecycle_events"));
    if (
      !sameStrings(bindingForeignKeys, [
        "license_key_hash:licenses.license_key_hash",
        "issuance_idempotency_key:license_issuance_events.idempotency_key"
      ].sort()) ||
      !sameStrings(lifecycleForeignKeys, [
        "license_key_hash:licenses.license_key_hash",
        "issuance_idempotency_key:checkout_subscription_bindings.issuance_idempotency_key"
      ].sort()) ||
      !sameStrings(this.uniqueColumnSets("checkout_subscription_bindings"), [
        "issuance_idempotency_key",
        "license_key_hash",
        "provider,provider_account_id,provider_mode,external_subscription_id"
      ].sort()) ||
      !sameStrings(this.uniqueColumnSets("license_subscription_lifecycle_events"), ["event_id"])
    ) {
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

function normalizeColumn(value: TableColumn): TableColumn {
  return {
    name: value.name,
    type: value.type.toUpperCase(),
    notnull: Number(value.notnull),
    dflt_value: value.dflt_value?.replaceAll(/\s+/g, " ") ?? null,
    pk: Number(value.pk)
  };
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function foreignKeySignatures(rows: readonly ForeignKeyRow[]): string[] {
  return rows.map((row) => `${row.from}:${row.table}.${row.to}`).sort();
}
