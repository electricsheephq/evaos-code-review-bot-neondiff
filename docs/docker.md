# Docker Operator Guide

The Docker recipe is for local or self-hosted workers where config, state,
evidence, and checkout work directories are mounted as volumes. It is not a
hosted NeonDiff SaaS path and does not bundle model credits.

## Compose Quick Start

Copy the example and provide secrets through an untracked `.env` file:

```bash
cp docker-compose.example.yml docker-compose.local.yml
cat > .env <<'EOF'
NEONDIFF_GITHUB_APP_ID=123456
NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH=/config/neondiff.private-key.pem
EOF
```

Mount your config at `/config/config.local.json` and keep keys outside git:

```bash
docker compose -f docker-compose.local.yml build neondiff
docker compose -f docker-compose.local.yml up -d neondiff
docker compose -f docker-compose.local.yml logs -f neondiff
```

The example also includes an `ollama` service for local OpenAI-compatible
provider experiments. It is optional; remove it if your provider runs elsewhere.

The image runs as the bundled non-root `node` user. The example daemon command
is deliberately explicit about `--dry-run true`, so a first deploy can prove the
worker loop and evidence path without posting GitHub comments. To post live
reviews from Docker, change the compose command to:

```yaml
command: ["daemon", "--config", "/config/config.local.json", "--dry-run", "false"]
```

The long-running daemon worker uses `--dry-run` as its posting boundary; it does
not implement the `--confirm true` gate used by one-shot `review-pr` live posting
and launchd mutation commands. Only switch Docker to `--dry-run false` after
`doctor`, provider readiness, repo allowlist, current-head proof, duplicate
suppression, and issue/PR approval are recorded.

## Healthcheck And Readiness

The image healthcheck runs `neondiff help` as a cheap process/CLI liveness
check. It intentionally does not read the mounted config, call a provider, or
distinguish dry-run from live posting mode. Treat it as container liveness only.
Use explicit readiness checks before live review:

```bash
docker compose -f docker-compose.local.yml exec neondiff \
  neondiff providers list --config /config/config.local.json --json
docker compose -f docker-compose.local.yml exec neondiff \
  neondiff doctor --config /config/config.local.json --json
```

## Volumes

Recommended mounts:

| Mount | Purpose |
| --- | --- |
| `/config` | Local config, GitHub App private key path, and untracked env inputs |
| `/state` | SQLite state DBs and license cache files |
| `/evidence` | Redacted review evidence packets |
| `/work` | Bare mirrors and per-PR worktrees |

Do not bake GitHub App keys, provider API keys, license keys, customer data, or
raw review evidence into the image.
