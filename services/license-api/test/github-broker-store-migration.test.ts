import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { GitHubBrokerStore } from "../src/github-broker/index.ts";

/**
 * The broker store must upgrade an EXISTING v1 database in place. Base f9f52d2
 * shipped `user_version = 1` with `installation_bindings` and NO
 * `binding_repositories`; the per-repo authorized-set work (v2) adds that table.
 * Without a migration, `ensureSchema` returned early on a v1 DB and
 * `upsertBinding` / `listBindingRepositories` threw "no such table" — bricking
 * every existing deployment on upgrade (it fails closed, but the broker 500s on
 * every connect/token). These tests pin the v1 -> v2 migration: the table is
 * created in place, a bind/list round-trips, and re-opening is idempotent.
 */

const V1_SCHEMA = `
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
  create table decision_ledger (
    id integer primary key autoincrement,
    device_id text not null,
    installation_id integer,
    decision text not null,
    reason_code text not null,
    created_at text not null
  );
`;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Materialize a DB at the pre-upgrade v1 schema with a device + binding already present. */
function seedV1Database(): string {
  const dir = mkdtempSync(join(tmpdir(), "broker-mig-"));
  dirs.push(dir);
  const path = join(dir, "broker.db");
  const db = new DatabaseSync(path);
  db.exec("pragma foreign_keys = on");
  db.exec(V1_SCHEMA);
  const now = new Date().toISOString();
  db.prepare("insert into devices (device_id, public_jwk, created_at, last_seen_at) values (?, ?, ?, ?)").run("dev-1", "{}", now, now);
  db.prepare("insert into installation_bindings (device_id, installation_id, account_login, created_at) values (?, ?, ?, ?)").run("dev-1", 4242, "octo", now);
  db.exec("pragma user_version = 1");
  db.close();
  return path;
}

describe("github broker store v1 -> v2 migration", () => {
  it("adds binding_repositories on an existing v1 DB and a bind/list round-trips", () => {
    const path = seedV1Database();
    // Opening the store runs ensureSchema, which must migrate v1 -> v2 in place.
    const store = new GitHubBrokerStore(path);
    try {
      // The migrated table now exists (this threw "no such table" before the fix),
      // and the pre-existing binding simply has an empty authorized set.
      assert.deepEqual(store.listBindingRepositories("dev-1", 4242), []);
      // A fresh bind writes the per-repo authorized set and it round-trips.
      store.upsertBinding("dev-1", 4242, "octo", ["octo/a", "octo/b"], new Date().toISOString());
      assert.deepEqual(store.listBindingRepositories("dev-1", 4242).sort(), ["octo/a", "octo/b"]);
    } finally {
      store.close();
    }
  });

  it("re-opening the migrated DB is idempotent (stays at v2, data intact)", () => {
    const path = seedV1Database();
    const first = new GitHubBrokerStore(path);
    first.upsertBinding("dev-1", 4242, "octo", ["octo/a"], new Date().toISOString());
    first.close();
    // A second open must not re-run the migration or lose the authorized set.
    const second = new GitHubBrokerStore(path);
    try {
      assert.deepEqual(second.listBindingRepositories("dev-1", 4242), ["octo/a"]);
    } finally {
      second.close();
    }
  });
});
