import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

interface SchemaObjectSignature {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

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

function readSchemaSignature(db: DatabaseSync): SchemaObjectSignature[] {
  const rows = db.prepare(
    `select type, name, tbl_name, sql
     from sqlite_schema
     where name not like 'sqlite_%'
     order by type, name`
  ).all() as unknown as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string;
  }>;
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

function expectedLegacySignature(): SchemaObjectSignature[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(LEGACY_SCHEMA);
    return readSchemaSignature(db);
  } finally {
    db.close();
  }
}

function verifyLegacyRestore(path: string): void {
  if (!statSync(path).isFile()) throw new Error("restore target must be a regular file");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const quickCheck = db.prepare("pragma quick_check").all() as unknown as Array<Record<string, unknown>>;
    if (quickCheck.length !== 1 || Object.values(quickCheck[0] ?? {})[0] !== "ok") {
      throw new Error("restore quick-check failed");
    }
    const versionRow = db.prepare("pragma user_version").get() as { user_version: number };
    if (Number(versionRow.user_version) !== 0) {
      throw new Error("restore is not schema version 0");
    }
    if (JSON.stringify(readSchemaSignature(db)) !== JSON.stringify(expectedLegacySignature())) {
      throw new Error("restore does not match the exact legacy schema signature");
    }
  } finally {
    db.close();
  }
}

const target = process.argv[2];
if (!target || process.argv.length !== 3) {
  console.error("usage: verify-legacy-restore <fresh-restored-database-path>");
  process.exit(2);
}

try {
  verifyLegacyRestore(target);
  console.log("legacy restore verification ok");
} catch (error) {
  console.error(error instanceof Error ? error.message : "legacy restore verification failed");
  process.exit(1);
}
