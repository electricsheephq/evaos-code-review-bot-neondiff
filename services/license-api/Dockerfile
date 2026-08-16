# syntax=docker/dockerfile:1

# NeonDiff license-api (#327) — deploy image.
#
# Build context MUST be the monorepo root (not this directory), because the
# service keeps its runtime dependencies in its own locked package while its
# `tsc` build tool is also available from the root devDependency. Build with:
#   docker build -f services/license-api/Dockerfile -t neondiff-license .
# from the repo root.
#
# Runtime dependencies are installed from services/license-api/package-lock.json.

ARG NODE_VERSION=26-slim
ARG LITESTREAM_VERSION=0.5.14

# ---- litestream binary stage ------------------------------------------------
FROM debian:bookworm-slim AS litestream
ARG LITESTREAM_VERSION
ARG TARGETARCH=amd64

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl tar; \
  case "${TARGETARCH}" in \
    amd64) litestream_arch="x86_64"; litestream_sha="32083dd2af13840b273c538360b828368d7b82bbaa2c641106052dc7814ed956" ;; \
    arm64) litestream_arch="arm64"; litestream_sha="b49b3d01fb0a8b4d426ee613c080fba44acae0551587dc43525dcd93eee64b4f" ;; \
    *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${litestream_arch}.tar.gz" -o /tmp/litestream.tar.gz; \
  echo "${litestream_sha}  /tmp/litestream.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream; \
  chmod +x /usr/local/bin/litestream; \
  litestream version; \
  rm -rf /var/lib/apt/lists/* /tmp/litestream.tar.gz

# ---- build stage -----------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /repo

# Root manifest + lockfile first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Service dependency lock and source.
COPY services/license-api/package.json services/license-api/package-lock.json services/license-api/tsconfig.json services/license-api/
RUN npm ci --prefix services/license-api --ignore-scripts
COPY services/license-api/src services/license-api/src

# Compile via the service's own build script, using the root-installed
# TypeScript devDependency. Output: services/license-api/dist/*.js
RUN npx --prefix . tsc -p services/license-api/tsconfig.json

# ---- runtime stage ----------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Compiled output plus production-only service dependencies; no source or devDependencies.
COPY --from=build /repo/services/license-api/dist ./dist
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY services/license-api/package.json services/license-api/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY services/license-api/litestream.yml /etc/litestream.yml
COPY services/license-api/litestream-broker.yml /etc/litestream-broker.yml
COPY services/license-api/docker-entrypoint.sh /usr/local/bin/license-api-entrypoint

# SQLite lives on a mounted volume; the app creates the file itself on startup.
# Keep the image mount point writable for local/dev runs without an attached
# Fly volume, and verify the mounted-volume ownership during staging DR drills.
RUN mkdir -p /data && chown node:node /data && chmod +x /usr/local/bin/license-api-entrypoint
VOLUME ["/data"]

ENV LICENSE_DB_PATH=/data/license.sqlite
ENV LITESTREAM_CONFIG=/etc/litestream.yml
ENV LITESTREAM_SYNC_INTERVAL=1s
ENV LICENSE_LITESTREAM_REQUIRED=true
ENV GITHUB_BROKER_DB_PATH=/data/github-broker.sqlite
ENV GITHUB_BROKER_LITESTREAM_CONFIG=/etc/litestream-broker.yml
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Runs unprivileged: node:*-slim images ship a non-root "node" user.
USER node

# The entrypoint performs the missing-file restore, then either fails closed
# without a replica URL or starts Litestream supervising this command.
ENTRYPOINT ["license-api-entrypoint"]
CMD ["node", "dist/server.js"]
