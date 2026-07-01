# Operator CLI

The bot has a JSON-first operator CLI for humans, manager agents, and reviewer
agents. It is the preferred way to answer runtime questions before touching
launchd, SQLite, or GitHub state by hand.

Run commands from the repository checkout:

```bash
npx tsx src/cli.ts status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

After `npm run build`, the package also exposes:

```bash
evaos-review-bot status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

## Commands

- `status`: aggregated operator health. Includes release gates, launchd,
  heartbeat, DB error/cooldown counts, coverage buckets, active/stale leases,
  and recommended actions.
- `agents`: launchd, heartbeat, and review-run lease inventory. This is
  read-only; it does not restart, kill, prune, or retire anything.
- `queue`: open PR-head coverage grouped into processed, provider-deferred,
  pending review, skipped, stale-head, and read-failure buckets.
- `coverage`: raw coverage-audit report with the shorter operator command name.
- `cooldowns`: provider cooldown review rows plus repo/global cooldown rows.
- `why --repo <owner/name> --pr <number>`: scoped explanation for why one PR
  head is processed, pending, provider-deferred, skipped, blocked by a read
  failure, or unknown.
- `doctor`: auth/config readiness. Use this for GitHub App/ZCode readiness, not
  runtime health.

## Common Operator Flows

Check whether the live bot is healthy:

```bash
npx tsx src/cli.ts status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

See whether review agents are active, idle, or stale:

```bash
npx tsx src/cli.ts agents --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

Find open PR heads that still need review work:

```bash
npx tsx src/cli.ts queue --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

Explain one PR:

```bash
npx tsx src/cli.ts why --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --repo 100yenadmin/Lossless-Codex-Orchestrator-LCO --pr 253
```

Inspect provider cooldowns:

```bash
npx tsx src/cli.ts cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true
```

## Safety Boundaries

Default operator commands are read-only. They can return nonzero when a gate is
unhealthy, but they do not mutate GitHub, launchd, config files, worktrees, or
SQLite rows.

Mutating commands remain explicit:

- `retry-provider-cooldowns --dry-run false`
- `retry-failed --dry-run false`
- `retire-failed`
- `run-once --dry-run false`
- `daemon --dry-run false`

The CLI intentionally does not implement a global pause-all policy,
one-at-a-time global queue policy, process killing, or Z.ai peak-hour blackout.
Those belong to scheduler/session work and documented operator decisions, not
hidden CLI side effects.
