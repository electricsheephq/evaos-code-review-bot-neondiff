# syntax=docker/dockerfile:1

# NeonDiff license-api (#327) — deploy image.
#
# Build context MUST be the monorepo root (not this directory), because the
# service has zero runtime dependencies of its own and its `tsc` build tool
# comes from the root devDependency (see ../../package.json). Build with:
#   docker build -f services/license-api/Dockerfile -t neondiff-license .
# from the repo root.
#
# Runtime is Node stdlib only (node:http, node:sqlite, node:fs, node:path) —
# no npm dependencies are installed in the final image.

ARG NODE_VERSION=26-slim

# ---- build stage -----------------------------------------------------------
FROM node:${NODE_VERSION} AS build
WORKDIR /repo

# Root manifest + lockfile first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Service source (package.json/tsconfig.json only needed for `tsc -p`).
COPY services/license-api/package.json services/license-api/tsconfig.json services/license-api/
COPY services/license-api/src services/license-api/src

# Compile via the service's own build script, using the root-installed
# TypeScript devDependency. Output: services/license-api/dist/*.js
RUN npx --prefix . tsc -p services/license-api/tsconfig.json

# ---- runtime stage ----------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Compiled output only — no node_modules, no source, no devDependencies.
COPY --from=build /repo/services/license-api/dist ./dist
COPY services/license-api/package.json ./package.json

# SQLite lives on a mounted volume; the app creates the file (and any missing
# parent directories) itself on startup via mkdirSync — see src/store.ts.
# The mount point just needs to exist so the volume can attach to it.
RUN mkdir -p /data
VOLUME ["/data"]

ENV LICENSE_DB_PATH=/data/license.sqlite
ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# Runs unprivileged: node:*-slim images ship a non-root "node" user.
USER node

# Matches the service's own `"start": "node dist/server.js"` exactly.
CMD ["node", "dist/server.js"]
