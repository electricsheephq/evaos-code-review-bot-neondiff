import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

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

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("pragma foreign_keys = on");
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      create table if not exists licenses (
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

      create table if not exists activations (
        license_key_hash text not null,
        machine_id text not null,
        repo text,
        activated_at text not null default (datetime('now')),
        last_seen_at text not null default (datetime('now')),
        primary key (license_key_hash, machine_id)
      );

      create table if not exists license_issuance_events (
        idempotency_key text primary key,
        license_key_hash text not null,
        request_hash text not null,
        source text,
        external_ref text,
        created_at text not null default (datetime('now')),
        foreign key (license_key_hash) references licenses(license_key_hash)
      );
    `);
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
