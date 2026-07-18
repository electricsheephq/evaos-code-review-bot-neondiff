#!/bin/sh
set -eu

: "${LICENSE_DB_PATH:=/data/license.sqlite}"
: "${LITESTREAM_CONFIG:=/etc/litestream.yml}"
: "${LITESTREAM_SYNC_INTERVAL:=1s}"
: "${LICENSE_LITESTREAM_REQUIRED:=true}"
: "${GITHUB_BROKER_ENABLED:=false}"
: "${GITHUB_BROKER_DB_PATH:=/data/github-broker.sqlite}"
: "${GITHUB_BROKER_LITESTREAM_CONFIG:=/etc/litestream-broker.yml}"
export LICENSE_DB_PATH LITESTREAM_CONFIG LITESTREAM_SYNC_INTERVAL LICENSE_LITESTREAM_REQUIRED
export GITHUB_BROKER_ENABLED GITHUB_BROKER_DB_PATH GITHUB_BROKER_LITESTREAM_CONFIG

mkdir -p "$(dirname "$LICENSE_DB_PATH")"

broker_replication_configured=false
if [ -n "${GITHUB_BROKER_REPLICA_URL:-}" ]; then
  if [ "$GITHUB_BROKER_DB_PATH" = "$LICENSE_DB_PATH" ]; then
    echo "GITHUB_BROKER_DB_PATH must differ from LICENSE_DB_PATH; refusing to start." >&2
    exit 1
  fi
  if [ "${LICENSE_REPLICA_URL:-}" = "$GITHUB_BROKER_REPLICA_URL" ]; then
    echo "GITHUB_BROKER_REPLICA_URL must differ from LICENSE_REPLICA_URL; refusing to start." >&2
    exit 1
  fi
  LITESTREAM_CONFIG="$GITHUB_BROKER_LITESTREAM_CONFIG"
  export LITESTREAM_CONFIG GITHUB_BROKER_REPLICA_URL
  mkdir -p "$(dirname "$GITHUB_BROKER_DB_PATH")"
  broker_replication_configured=true
elif [ "$GITHUB_BROKER_ENABLED" = "true" ]; then
  echo "GITHUB_BROKER_REPLICA_URL is unset; refusing to enable the managed GitHub broker without independent Litestream DR replication." >&2
  exit 1
fi

if [ -z "${LICENSE_REPLICA_URL:-}" ]; then
  if [ "$LICENSE_LITESTREAM_REQUIRED" = "true" ] ||
    [ "$GITHUB_BROKER_ENABLED" = "true" ] ||
    [ "$broker_replication_configured" = "true" ]; then
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

if [ "$broker_replication_configured" = "true" ]; then
  if [ ! -f "$GITHUB_BROKER_DB_PATH" ]; then
    echo "GitHub broker database is missing at $GITHUB_BROKER_DB_PATH; attempting Litestream restore." >&2
    litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$GITHUB_BROKER_DB_PATH"
  else
    echo "GitHub broker database exists at $GITHUB_BROKER_DB_PATH; skipping restore." >&2
  fi
fi

exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node dist/server.js"
