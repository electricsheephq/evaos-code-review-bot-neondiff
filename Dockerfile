# Node 26 is intentional: package.json requires node >=26 for this beta CLI.
FROM node:26-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci
COPY src ./src
COPY scripts ./scripts
COPY shared ./shared
COPY docs ./docs
COPY config.example.json LICENSE.md README.md SECURITY.md CODE_OF_CONDUCT.md ./
RUN npm run build
RUN npm prune --omit=dev && rm -rf scripts shared dist/tests

# Keep runtime on Node 26 so Docker matches the published package engine.
FROM node:26-bookworm-slim

ENV NODE_ENV=production
ENV NEONDIFF_CONFIG=/config/config.local.json

WORKDIR /app
COPY --from=build /app /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends lsof \
  && rm -rf /var/lib/apt/lists/* \
  && npm link \
  && mkdir -p /config /state /evidence /work \
  && chown -R node:node /app /config /state /evidence /work

VOLUME ["/config", "/state", "/evidence", "/work"]

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD node -e 'const fs = require("node:fs"); const cmd = fs.readFileSync("/proc/1/cmdline", "utf8").replace(/\0/g, " "); if (!/\bdaemon\b/.test(cmd)) process.exit(1);'

ENTRYPOINT ["neondiff"]

# Equivalent operator command: neondiff daemon --config /config/config.local.json --dry-run true
CMD ["daemon", "--config", "/config/config.local.json", "--dry-run", "true"]
