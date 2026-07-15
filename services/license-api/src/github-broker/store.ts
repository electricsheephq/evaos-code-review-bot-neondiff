import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Persistence for the GitHub App broker. Mirrors the LicenseStore patterns
 * (DatabaseSync, `pragma foreign_keys`, user_version migration guard, prepared
 * statements, row mapping) but lives in its OWN database so the license store's
 * strict schema verification is unaffected and the two schemas evolve
 * independently (see docs/security/github-app-broker.md, "Architecture").
 *
 * Retention (public-safe by construction): device public keys, one-shot connect
 * states, installation bindings, and an append-only decision ledger. No tokens,
 * private keys, source, or diffs are ever stored.
 */
const SCHEMA_VERSION = 2;
const DEFAULT_BUSY_TIMEOUT_MS = 250;

/**
 * The per-repo authorized-set table. Extracted so a fresh bootstrap and the
 * v1 -> v2 upgrade create the exact same table (base v1 shipped
 * `installation_bindings` without it, so an existing broker DB must gain it).
 */
const BINDING_REPOSITORIES_TABLE = `
  create table binding_repositories (
    device_id text not null,
    installation_id integer not null,
    full_name text not null,
    primary key (device_id, installation_id, full_name),
    foreign key (device_id, installation_id)
      references installation_bindings(device_id, installation_id) on delete cascade
  );
`;

const SCHEMA = `
  create table devices (
    device_id text primary key,
    public_jwk text not null,
    created_at text not null,
    last_seen_at text not null
  );

  create table connect_states (
    state text primary key,
    device_id text not null,
    installation_id integer,
    created_at text not null,
    expires_at text not null,
    consumed_at text,
    foreign key (device_id) references devices(device_id)
  );

  create table installation_bindings (
    device_id text not null,
    installation_id integer not null,
    account_login text,
    created_at text not null,
    primary key (device_id, installation_id),
    foreign key (device_id) references devices(device_id)
  );

  ${BINDING_REPOSITORIES_TABLE.trim()}

  create table decision_ledger (
    id integer primary key autoincrement,
    device_id text not null,
    installation_id integer,
    decision text not null,
    reason_code text not null,
    created_at text not null
  );
`;

export interface DeviceRow {
  device_id: string;
  public_jwk: string;
  created_at: string;
  last_seen_at: string;
}

export interface ConnectStateRow {
  state: string;
  device_id: string;
  installation_id: number | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface InstallationBindingRow {
  device_id: string;
  installation_id: number;
  account_login: string | null;
  created_at: string;
}

export interface DecisionLedgerRow {
  id: number;
  device_id: string;
  installation_id: number | null;
  decision: string;
  reason_code: string;
  created_at: string;
}

export class GitHubBrokerStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath, { timeout: DEFAULT_BUSY_TIMEOUT_MS });
    try {
      this.db.exec("pragma foreign_keys = on");
      this.ensureSchema();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private ensureSchema(): void {
    const version = this.readUserVersion();
    if (version === SCHEMA_VERSION) return;
    if (version !== 0 && version !== 1) {
      throw new Error(`unsupported github broker schema version ${version}`);
    }
    this.db.exec("begin immediate");
    try {
      // Re-check under the writer lock in case a peer migrated first.
      const current = this.readUserVersion();
      if (current === SCHEMA_VERSION) {
        this.db.exec("commit");
        return;
      }
      if (current === 0) {
        // Fresh bootstrap: the full schema (already includes binding_repositories).
        this.db.exec(SCHEMA);
      } else {
        // v1 -> v2 upgrade: base v1 shipped installation_bindings WITHOUT the
        // per-repo authorized-set table, so an existing broker DB must gain it in
        // place — otherwise upsertBinding/listBindingRepositories hit "no such
        // table". Idempotent and crash-safe under the same writer transaction.
        this.db.exec(BINDING_REPOSITORIES_TABLE);
      }
      this.db.exec(`pragma user_version = ${SCHEMA_VERSION}`);
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

  close(): void {
    this.db.close();
  }

  /** Register or refresh a device public key. Idempotent: the id is the key thumbprint. */
  upsertDevice(deviceId: string, publicJwk: string, now: string): void {
    this.db
      .prepare(
        `insert into devices (device_id, public_jwk, created_at, last_seen_at)
         values (?, ?, ?, ?)
         on conflict (device_id)
         do update set public_jwk = excluded.public_jwk, last_seen_at = excluded.last_seen_at`
      )
      .run(deviceId, publicJwk, now, now);
  }

  getDevice(deviceId: string): DeviceRow | undefined {
    return this.db.prepare("select * from devices where device_id = ?").get(deviceId) as DeviceRow | undefined;
  }

  touchDevice(deviceId: string, now: string): void {
    this.db.prepare("update devices set last_seen_at = ? where device_id = ?").run(now, deviceId);
  }

  createConnectState(state: string, deviceId: string, createdAt: string, expiresAt: string): void {
    this.db
      .prepare(
        `insert into connect_states (state, device_id, created_at, expires_at) values (?, ?, ?, ?)`
      )
      .run(state, deviceId, createdAt, expiresAt);
  }

  getConnectState(state: string): ConnectStateRow | undefined {
    return this.db
      .prepare("select * from connect_states where state = ?")
      .get(state) as ConnectStateRow | undefined;
  }

  /**
   * Atomically consume a one-shot connect state. Returns true only for the first
   * caller; a second callback for the same state changes no rows (state_replayed).
   */
  consumeConnectState(state: string, installationId: number, consumedAt: string): boolean {
    const info = this.db
      .prepare(
        `update connect_states set consumed_at = ?, installation_id = ?
         where state = ? and consumed_at is null`
      )
      .run(consumedAt, installationId, state);
    return Number(info.changes) > 0;
  }

  /**
   * Record (or refresh) a binding and REPLACE its authorized-repository set in one
   * transaction. `authorizedRepositories` is the exact `owner/name` set the
   * connecting OAuth user can access in the installation; token issuance is later
   * confined to it, so an entitled-but-GitHub-unauthorized user cannot reach a
   * private repo outside their access. Re-connecting refreshes the set atomically.
   */
  upsertBinding(
    deviceId: string,
    installationId: number,
    accountLogin: string | undefined,
    authorizedRepositories: string[],
    now: string
  ): void {
    this.db.exec("begin immediate");
    try {
      this.db
        .prepare(
          `insert into installation_bindings (device_id, installation_id, account_login, created_at)
           values (?, ?, ?, ?)
           on conflict (device_id, installation_id)
           do update set account_login = excluded.account_login`
        )
        .run(deviceId, installationId, accountLogin ?? null, now);
      this.db
        .prepare("delete from binding_repositories where device_id = ? and installation_id = ?")
        .run(deviceId, installationId);
      const insert = this.db.prepare(
        `insert or ignore into binding_repositories (device_id, installation_id, full_name)
         values (?, ?, ?)`
      );
      for (const fullName of authorizedRepositories) insert.run(deviceId, installationId, fullName);
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  getBinding(deviceId: string, installationId: number): InstallationBindingRow | undefined {
    return this.db
      .prepare("select * from installation_bindings where device_id = ? and installation_id = ?")
      .get(deviceId, installationId) as InstallationBindingRow | undefined;
  }

  /** The `owner/name` set the connecting OAuth user was authorized for at bind time. */
  listBindingRepositories(deviceId: string, installationId: number): string[] {
    const rows = this.db
      .prepare("select full_name from binding_repositories where device_id = ? and installation_id = ?")
      .all(deviceId, installationId) as Array<{ full_name: string }>;
    return rows.map((row) => row.full_name);
  }

  /** Append a public-safe decision row. Never carries repo content or key material. */
  appendDecision(
    deviceId: string,
    installationId: number | null,
    decision: "allow" | "deny",
    reasonCode: string,
    now: string
  ): void {
    this.db
      .prepare(
        `insert into decision_ledger (device_id, installation_id, decision, reason_code, created_at)
         values (?, ?, ?, ?, ?)`
      )
      .run(deviceId, installationId, decision, reasonCode, now);
  }

  listDecisions(deviceId?: string): DecisionLedgerRow[] {
    const rows = deviceId
      ? this.db.prepare("select * from decision_ledger where device_id = ? order by id asc").all(deviceId)
      : this.db.prepare("select * from decision_ledger order by id asc").all();
    return rows as unknown as DecisionLedgerRow[];
  }
}
