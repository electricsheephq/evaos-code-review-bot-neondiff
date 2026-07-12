import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { LicenseStore, type SchemaMigrationStep } from "../src/store.ts";

const LEGACY_SCHEMA = `
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

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "neondiff-license-migration-"));
  tempDirectories.push(directory);
  return join(directory, "license.sqlite");
}

function open(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

function userVersion(db: DatabaseSync): number {
  return Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
}

function objectNames(db: DatabaseSync, type: "table" | "index" | "trigger" | "view"): string[] {
  return (
    db
      .prepare("select name from sqlite_schema where type = ? and name not like 'sqlite_%' order by name")
      .all(type) as unknown as Array<{ name: string }>
  ).map(({ name }) => name);
}

function schemaRows(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      `select type, name, tbl_name, sql
       from sqlite_schema
       where name not like 'sqlite_%'
       order by type, name`
    )
    .all();
}

function createLegacyDatabase(path: string): void {
  const db = open(path);
  db.exec("pragma foreign_keys = on");
  db.exec(LEGACY_SCHEMA);
  db.prepare(
    `insert into licenses (
      license_key_hash, plan, repo_visibility_scope, private_repo_allowed,
      update_entitlement, seats, expires_at, status, created_at
    ) values (?, 'yearly_support', 'private', 1, 1, 1, ?, 'active', ?)`
  ).run("legacy-license-hash", "2027-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
  db.prepare(
    `insert into activations (
      license_key_hash, machine_id, repo, activated_at, last_seen_at
    ) values (?, ?, ?, ?, ?)`
  ).run(
    "legacy-license-hash",
    "legacy-machine",
    "electricsheephq/example",
    "2026-07-13T00:01:00.000Z",
    "2026-07-13T00:02:00.000Z"
  );
  db.prepare(
    `insert into license_issuance_events (
      idempotency_key, license_key_hash, request_hash, source, external_ref, created_at
    ) values (?, ?, ?, 'checkout', ?, ?)`
  ).run(
    "checkout-session:legacy",
    "legacy-license-hash",
    "legacy-request-hash",
    "legacy-checkout-ref",
    "2026-07-13T00:00:00.000Z"
  );
  db.close();
}

function assertLegacyRowsPreserved(db: DatabaseSync): void {
  assert.deepEqual({ ...db.prepare("select * from licenses").get() }, {
    license_key_hash: "legacy-license-hash",
    plan: "yearly_support",
    repo_visibility_scope: "private",
    private_repo_allowed: 1,
    update_entitlement: 1,
    seats: 1,
    expires_at: "2027-07-13T00:00:00.000Z",
    status: "active",
    revocation_reason: null,
    created_at: "2026-07-13T00:00:00.000Z"
  });
  assert.deepEqual({ ...db.prepare("select * from activations").get() }, {
    license_key_hash: "legacy-license-hash",
    machine_id: "legacy-machine",
    repo: "electricsheephq/example",
    activated_at: "2026-07-13T00:01:00.000Z",
    last_seen_at: "2026-07-13T00:02:00.000Z"
  });
  assert.deepEqual({ ...db.prepare("select * from license_issuance_events").get() }, {
    idempotency_key: "checkout-session:legacy",
    license_key_hash: "legacy-license-hash",
    request_hash: "legacy-request-hash",
    source: "checkout",
    external_ref: "legacy-checkout-ref",
    created_at: "2026-07-13T00:00:00.000Z"
  });
}

describe("license store schema v2 migration", () => {
  it("bootstraps an empty version-zero database directly to the complete v2 schema", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    store.close();

    const db = open(path);
    assert.equal(userVersion(db), 2);
    assert.deepEqual(objectNames(db, "table"), [
      "activations",
      "checkout_subscription_bindings",
      "license_issuance_events",
      "license_subscription_lifecycle_events",
      "licenses"
    ]);
    assert.ok(
      objectNames(db, "index").includes("license_subscription_lifecycle_events_issuance_time_idx")
    );
    assert.deepEqual(
      (
        db.prepare("pragma table_info(checkout_subscription_bindings)").all() as unknown as Array<{ name: string }>
      ).map(({ name }) => name),
      [
        "issuance_idempotency_key",
        "license_key_hash",
        "provider",
        "provider_account_id",
        "provider_mode",
        "external_subscription_id",
        "external_checkout_id",
        "last_non_mutating_event_created_at",
        "created_at"
      ]
    );
    assert.deepEqual(
      (
        db.prepare("pragma table_info(license_subscription_lifecycle_events)").all() as unknown as Array<{
          name: string;
        }>
      ).map(({ name }) => name),
      [
        "event_id",
        "issuance_idempotency_key",
        "license_key_hash",
        "external_subscription_id",
        "request_hash",
        "event_created_at",
        "provider",
        "provider_account_id",
        "provider_mode",
        "provider_event_type",
        "command",
        "payment_reference_fingerprint",
        "normalized_transition",
        "result",
        "created_at"
      ]
    );
    db.close();
  });

  it("migrates only the exact legacy three-table schema and preserves every legacy row", () => {
    const path = databasePath();
    createLegacyDatabase(path);

    const store = new LicenseStore(path);
    store.close();

    const db = open(path);
    assert.equal(userVersion(db), 2);
    assertLegacyRowsPreserved(db);
    assert.ok(objectNames(db, "table").includes("checkout_subscription_bindings"));
    assert.ok(objectNames(db, "table").includes("license_subscription_lifecycle_events"));
    db.close();
  });

  it("reopens schema v2 without changing its schema or data", () => {
    const path = databasePath();
    createLegacyDatabase(path);
    new LicenseStore(path).close();

    const before = open(path);
    const schemaBefore = before
      .prepare("select type, name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name")
      .all();
    before.close();

    new LicenseStore(path).close();

    const after = open(path);
    assert.equal(userVersion(after), 2);
    assert.deepEqual(
      after.prepare("select type, name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name").all(),
      schemaBefore
    );
    assertLegacyRowsPreserved(after);
    after.close();
  });

  it("rejects an unknown non-empty version-zero schema before any mutation", () => {
    const path = databasePath();
    const db = open(path);
    db.exec("create table unexpected (value text not null); insert into unexpected values ('preserve-me')");
    db.close();

    assert.throws(() => new LicenseStore(path), /unknown non-empty schema at user_version 0/);

    const inspected = open(path);
    assert.equal(userVersion(inspected), 0);
    assert.deepEqual(objectNames(inspected, "table"), ["unexpected"]);
    assert.deepEqual({ ...inspected.prepare("select * from unexpected").get() }, { value: "preserve-me" });
    inspected.close();
  });

  for (const [label, schema] of [
    ["an extra CHECK constraint", LEGACY_SCHEMA.replace("seats integer not null default 1", "seats integer not null default 1 check (seats > 0)")],
    [
      "an ON DELETE CASCADE action",
      LEGACY_SCHEMA.replace(
        "references licenses(license_key_hash)",
        "references licenses(license_key_hash) on delete cascade"
      )
    ]
  ] as const) {
    it(`rejects a legacy lookalike with ${label} before mutation`, () => {
      const path = databasePath();
      const db = open(path);
      db.exec(schema);
      const before = schemaRows(db);
      db.close();

      assert.throws(() => new LicenseStore(path), /unknown non-empty schema at user_version 0/);

      const inspected = open(path);
      assert.equal(userVersion(inspected), 0);
      assert.deepEqual(schemaRows(inspected), before);
      inspected.close();
    });
  }

  it("rejects a database labeled v2 when lifecycle constraints are missing", () => {
    const path = databasePath();
    const db = open(path);
    db.exec(LEGACY_SCHEMA);
    db.exec(`
      create table checkout_subscription_bindings (
        issuance_idempotency_key text primary key,
        license_key_hash text not null,
        provider text not null,
        provider_account_id text not null,
        provider_mode text not null,
        external_subscription_id text not null,
        external_checkout_id text not null,
        last_non_mutating_event_created_at integer,
        created_at text not null default (datetime('now'))
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
        created_at text not null default (datetime('now'))
      );
      create index license_subscription_lifecycle_events_issuance_time_idx
        on license_subscription_lifecycle_events (issuance_idempotency_key, event_created_at);
      pragma user_version = 2;
    `);
    db.close();

    assert.throws(() => new LicenseStore(path), /schema v2 has unexpected constraints/);
  });

  for (const [label, mutation, type, name] of [
    [
      "mutation trigger",
      `create trigger unexpected_license_mutation
       after update on licenses
       begin
         update licenses set status = 'revoked'
         where license_key_hash = new.license_key_hash;
       end`,
      "trigger",
      "unexpected_license_mutation"
    ],
    [
      "projection view",
      "create view unexpected_license_projection as select license_key_hash from licenses",
      "view",
      "unexpected_license_projection"
    ]
  ] as const) {
    it(`rejects an otherwise valid v2 schema with an unexpected ${label}`, () => {
      const path = databasePath();
      new LicenseStore(path).close();
      const db = open(path);
      db.exec(mutation);
      db.close();

      assert.throws(() => new LicenseStore(path), /schema v2 has unexpected objects/);

      const inspected = open(path);
      assert.equal(userVersion(inspected), 2);
      assert.deepEqual(objectNames(inspected, type), [name]);
      inspected.close();
    });
  }

  const rollbackCases: Array<{
    label: string;
    setup(path: string): void;
    steps: SchemaMigrationStep[];
    assertUnchanged(db: DatabaseSync): void;
    assertRecovered(db: DatabaseSync): void;
  }> = [
    {
      label: "empty bootstrap",
      setup() {},
      steps: ["core-schema-created", "lifecycle-schema-created", "schema-verified", "version-set"],
      assertUnchanged(db) {
        assert.equal(userVersion(db), 0);
        assert.deepEqual(schemaRows(db), []);
      },
      assertRecovered(db) {
        assert.equal(userVersion(db), 2);
        assert.deepEqual(objectNames(db, "table"), [
          "activations",
          "checkout_subscription_bindings",
          "license_issuance_events",
          "license_subscription_lifecycle_events",
          "licenses"
        ]);
      }
    },
    {
      label: "legacy migration",
      setup: createLegacyDatabase,
      steps: ["lifecycle-schema-created", "schema-verified", "version-set"],
      assertUnchanged(db) {
        assert.equal(userVersion(db), 0);
        assert.deepEqual(objectNames(db, "table"), ["activations", "license_issuance_events", "licenses"]);
        assert.deepEqual(objectNames(db, "index"), []);
        assertLegacyRowsPreserved(db);
      },
      assertRecovered(db) {
        assert.equal(userVersion(db), 2);
        assertLegacyRowsPreserved(db);
      }
    }
  ];

  for (const migration of rollbackCases) {
    for (const failingStep of migration.steps) {
      it(`rolls back ${migration.label} when ${failingStep} fails and later reopens cleanly`, () => {
        const path = databasePath();
        migration.setup(path);

        assert.throws(
          () =>
            new LicenseStore(path, {
              migrationHook(step) {
                if (step === failingStep) throw new Error(`deterministic failure at ${step}`);
              }
            }),
          new RegExp(`deterministic failure at ${failingStep}`)
        );

        const rolledBack = open(path);
        migration.assertUnchanged(rolledBack);
        rolledBack.close();

        new LicenseStore(path).close();
        const recovered = open(path);
        migration.assertRecovered(recovered);
        recovered.close();
      });
    }
  }
});
