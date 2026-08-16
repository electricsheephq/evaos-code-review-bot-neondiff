export interface SchemaObjectSignature {
  type: string;
  name: string;
  tableName: string;
  sql: string;
}

const LITESTREAM_INTERNAL_SCHEMA_SIGNATURE: readonly SchemaObjectSignature[] = [
  {
    type: "table",
    name: "_litestream_lock",
    tableName: "_litestream_lock",
    sql: "create table _litestream_lock(id integer)"
  },
  {
    type: "table",
    name: "_litestream_seq",
    tableName: "_litestream_seq",
    sql: "create table _litestream_seq(id integer primary key,seq integer)"
  }
];

const LITESTREAM_INTERNAL_NAMES = new Set(
  LITESTREAM_INTERNAL_SCHEMA_SIGNATURE.map(({ name }) => name)
);

/**
 * Litestream 0.5 creates two bookkeeping tables in the replicated database.
 * They are not part of the application schema, but ignoring an arbitrary
 * prefix would weaken the exact-schema gate. Strip them only when the complete
 * pair matches Litestream's exact normalized signature; partial or modified
 * lookalikes remain visible and fail the caller's schema comparison.
 */
export function stripVerifiedLitestreamInternalSchema(
  signature: readonly SchemaObjectSignature[]
): SchemaObjectSignature[] {
  const internal = signature.filter(({ name }) => LITESTREAM_INTERNAL_NAMES.has(name));
  if (internal.length === 0) return [...signature];
  if (JSON.stringify(internal) !== JSON.stringify(LITESTREAM_INTERNAL_SCHEMA_SIGNATURE)) {
    return [...signature];
  }
  return signature.filter(({ name }) => !LITESTREAM_INTERNAL_NAMES.has(name));
}
