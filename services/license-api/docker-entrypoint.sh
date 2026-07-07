#!/bin/sh
set -eu

: "${LICENSE_DB_PATH:=/data/license.sqlite}"
: "${LITESTREAM_CONFIG:=/etc/litestream.yml}"
: "${LITESTREAM_SYNC_INTERVAL:=1s}"
: "${LICENSE_LITESTREAM_REQUIRED:=true}"
export LICENSE_DB_PATH LITESTREAM_CONFIG LITESTREAM_SYNC_INTERVAL LICENSE_LITESTREAM_REQUIRED

mkdir -p "$(dirname "$LICENSE_DB_PATH")"

if [ -z "${LICENSE_REPLICA_URL:-}" ]; then
  if [ "$LICENSE_LITESTREAM_REQUIRED" = "true" ]; then
    echo "LICENSE_REPLICA_URL is unset; refusing to start production license-api without Litestream DR replication. Set LICENSE_REPLICA_URL via Fly secrets, or set LICENSE_LITESTREAM_REQUIRED=false for local/dev only." >&2
    exit 1
  fi
  echo "LICENSE_REPLICA_URL is unset; starting license-api without Litestream replication for local/dev only." >&2
  exec node dist/server.js
fi

if [ ! -f "$LICENSE_DB_PATH" ]; then
  echo "license-api database is missing at $LICENSE_DB_PATH; attempting Litestream restore." >&2
  litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$LICENSE_DB_PATH"
else
  echo "license-api database exists at $LICENSE_DB_PATH; skipping restore." >&2
fi

exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node dist/server.js"
