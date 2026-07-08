# Node 26 is intentional: package.json requires node >=26 for this beta CLI.
FROM node:26-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY docs ./docs
COPY config.example.json LICENSE.md README.md SECURITY.md CODE_OF_CONDUCT.md ./
RUN npm run build
RUN npm prune --omit=dev

# Keep runtime on Node 26 so Docker matches the published package engine.
FROM node:26-bookworm-slim

ENV NODE_ENV=production
ENV NEONDIFF_CONFIG=/config/config.local.json

WORKDIR /app
COPY --from=build /app /app
RUN npm link \
  && mkdir -p /config /state /evidence /work \
  && chown -R node:node /app /config /state /evidence /work

VOLUME ["/config", "/state", "/evidence", "/work"]

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD neondiff help >/dev/null || exit 1

ENTRYPOINT ["neondiff"]

# Equivalent operator command: neondiff daemon --config /config/config.local.json --dry-run true
CMD ["daemon", "--config", "/config/config.local.json", "--dry-run", "true"]
