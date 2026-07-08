FROM node:26-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY docs ./docs
COPY config.example.json LICENSE.md README.md SECURITY.md CODE_OF_CONDUCT.md ./
RUN npm run build
RUN npm prune --omit=dev

FROM node:26-bookworm-slim

ENV NODE_ENV=production
ENV NEONDIFF_CONFIG=/config/config.local.json

WORKDIR /app
COPY --from=build /app /app
RUN npm link

VOLUME ["/config", "/state", "/evidence", "/work"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD neondiff providers list --config "$NEONDIFF_CONFIG" --json >/dev/null || exit 1

# Equivalent operator command: neondiff daemon --config /config/config.local.json
CMD ["neondiff", "daemon", "--config", "/config/config.local.json"]
