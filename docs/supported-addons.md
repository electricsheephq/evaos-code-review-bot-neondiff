# Supported Addons Plan

NeonDiff should be useful with plain GitHub pull-request context first. Repo wiki
and code-intelligence addons can improve review quality, but they are advisory
inputs and must never become hidden requirements for the source-available beta.

This plan covers the supported-addon contract for:

- OpenWiki-compatible repo wiki packets
- GitNexus code-intelligence context packets

Related tracking:

- [#123 Supported addons: OpenWiki-compatible repo wiki and GitNexus context integration](https://github.com/electricsheephq/evaos-code-review-bot/issues/123)
- [#122 Repo wiki packet export for codebase maps, memory, and review context](https://github.com/electricsheephq/evaos-code-review-bot/issues/122)
- [#82 GitNexus context integration](https://github.com/electricsheephq/evaos-code-review-bot/issues/82)

## Decision

OpenWiki and GitNexus are the two major supported addons for improving
agent-facing review context. They are optional sources, not v1.0 launch
dependencies.

NeonDiff should prefer export and compatibility boundaries before importing
third-party source code:

- OpenWiki support starts as Markdown and JSON packet compatibility so OpenWiki
  can ingest NeonDiff repo memory, and agents can read the same packets without
  scraping a rendered wiki.
- GitNexus support starts as bounded context packets for changed files, related
  symbols, callers/callees, impact summaries, and indexed evidence links.
- Current GitHub PR metadata, current diff lines, and checkout files remain more
  authoritative than addon memory.
- Missing or stale addon data records degraded mode and continues the review
  with normal GitHub diff context.

## Relationship To Issue #122

Issue #122 owns the user-facing repo wiki packet export: generation,
deterministic provenance, redaction, token budget behavior, stale/missing packet
fixtures, and integration into review prompts.

Issue #123 owns the supported-addon strategy around that packet:

- which addon contracts NeonDiff promises to keep stable enough for users and
  agents to build around
- how OpenWiki-compatible repo wiki packets relate to GitNexus context packets
- which security, freshness, and degraded-mode boundaries both addon families
  share
- which acceptance gates are required before the addon story can be described
  as supported

Do not close #123 only because #122 has a repo-memory packet generator. Close
#123 only when the repo wiki and GitNexus addon contracts are documented,
discoverable, validated with fixtures, and represented in dry-run evidence.

## Common Addon Contract

Every addon packet should expose enough metadata for an agent or maintainer to
decide whether the context is useful, fresh, and safe:

```json
{
  "repo": "owner/name",
  "packetVersion": "addon-specific-version",
  "generatedAt": "2026-07-04T00:00:00.000Z",
  "sha256": "packet-rendering-hash",
  "byteEstimate": 12000,
  "tokenEstimate": 3000,
  "advisory": "Current PR diff, checkout files, and GitHub metadata remain authoritative.",
  "sources": [
    {
      "id": "human:repo-memory.md",
      "type": "markdown",
      "sha256": "source-hash",
      "stale": false
    }
  ],
  "degradedMode": false,
  "degradedReason": null,
  "redactionReportSha256": "redaction-report-hash"
}
```

Required fields:

- `repo`: GitHub `owner/name` for the target repository.
- `packetVersion`: stable version string for compatibility checks.
- `generatedAt`: ISO timestamp from packet build time.
- `sha256`: hash of the rendered packet body that will enter review context.
- `byteEstimate` and `tokenEstimate`: budget controls before prompt injection.
- `advisory`: explicit authority boundary; addon context is not source of
  truth.
- `sources`: source IDs, hashes, freshness flags, and source type.
- `degradedMode` and `degradedReason`: machine-readable missing, stale, or
  skipped state.
- `redactionReportSha256`: evidence hash for the redaction report; packet
  summaries must carry a separate status when pass/fail/redacted state is known.

Packet builders must fail closed when source text, metadata, or rendered packet
content contains secret-like data. Redacted previews may be used for operator
debugging, but raw secrets, raw customer data, private diffs, private logs,
tokens, keys, cookies, and connector URLs must not be committed or posted.

## OpenWiki-Compatible Repo Wiki

OpenWiki compatibility is an export/import contract, not an OpenWiki fork.

The first supported shape is a paired Markdown and JSON repo wiki packet:

```text
repo-memory-packet.md
repo-memory-packet.json
```

The Markdown packet should be readable by agents and importable or linkable by
wiki tools:

```md
# Durable repo memory packet

Repository: electricsheephq/evaos-code-review-bot
Packet version: repo-memory-packet-v0.1
Generated at: 2026-07-04T00:00:00.000Z

This memory is advisory. Current PR diff and current repository files override memory.

## Human repo-memory.md

### Repository Purpose

Local-first GitHub App reviewer for pull-request review.

## SQLite memory notes

### Release proof

id=note-policy; kind=policy_note; source=issue#78; confidence=0.8; updated_at=2026-07-01T00:00:00.000Z

Release notes must link release-status and rollback evidence.
```

The JSON packet should preserve the same rendered body and metadata:

```json
{
  "repo": "electricsheephq/evaos-code-review-bot",
  "packetVersion": "repo-memory-packet-v0.1",
  "generatedAt": "2026-07-04T00:00:00.000Z",
  "sha256": "rendered-markdown-sha256",
  "byteEstimate": 2048,
  "tokenEstimate": 512,
  "advisory": "This memory is advisory. Current PR diff and current repository files override memory.",
  "sources": [
    {
      "id": "human:repo-memory.md",
      "type": "human",
      "sha256": "source-sha256",
      "stale": false
    }
  ],
  "markdown": "# Durable repo memory packet\n...",
  "redactionReportSha256": "redaction-report-sha256"
}
```

Acceptance gates for OpenWiki-compatible support:

- A fixture repo can generate Markdown and JSON wiki packets.
- The packet includes architecture overview, key entrypoints, domain map, test
  commands, review rules, and known risky areas when those sources exist.
- Packet provenance proves which source files, memory notes, or config entries
  informed the wiki.
- Stale or missing wiki packets degrade gracefully and do not block reviews.
- Secret redaction and token-budget tests cover source text, metadata, and
  rendered packet output.
- An agent-docs smoke proves a coding agent can discover the packet command and
  interpret the output without scraping a rendered website.

OpenWiki source code must not be copied into NeonDiff unless a later provenance
and license/source audit approves that path.

## GitNexus Context

GitNexus support is a bounded advisory context contract for one pull request.
It should not index repositories during review, run tests, execute PR code, or
replace current checkout truth.

The packet shape should include:

```json
{
  "repo": "electricsheephq/evaos-code-review-bot",
  "pullNumber": 123,
  "headSha": "head-commit-sha",
  "baseSha": "base-commit-sha",
  "packetVersion": "gitnexus-context-packet-v0.1",
  "generatedAt": "2026-07-04T00:00:00.000Z",
  "sha256": "rendered-markdown-sha256",
  "gitnexus": {
    "alias": "evaos-code-review-bot",
    "indexCommit": "base-or-head-sha-prefix",
    "freshness": "fresh",
    "degradedMode": false
  },
  "changedFiles": [
    {
      "path": "src/worker.ts",
      "status": "modified",
      "generated": false,
      "symbolHints": ["worker"],
      "changedExportedSymbols": ["reviewPull"]
    }
  ],
  "relatedContext": [
    {
      "id": "query:src/worker.ts",
      "query": "src/worker.ts reviewPull worker",
      "reason": "Related GitNexus flows for changed file src/worker.ts.",
      "command": ["gitnexus", "query", "src/worker.ts reviewPull worker", "--repo", "evaos-code-review-bot"],
      "outputPreview": "bounded redacted preview"
    }
  ],
  "omittedContext": [],
  "markdown": "# GitNexus context packet\n...",
  "redactionReportSha256": "redaction-report-sha256"
}
```

Acceptance gates for GitNexus support:

- Fresh-index fixture includes bounded related context for changed files and
  symbols.
- Missing-index fixture emits degraded mode without querying GitNexus.
- Stale-index fixture emits degraded mode unless stale context was explicitly
  enabled for inspection.
- Generated paths and large outputs are omitted before exceeding packet budget.
- Secret-looking GitNexus output fails closed with a redacted report.
- Review prompt integration labels the packet advisory and preserves GitHub PR
  diff/checkouts as authoritative.

## Dry-Run Evidence

Before claiming supported-addon readiness, a dry-run packet bundle should record
public-safe evidence for both addon families:

```text
evidence/
  issue-123/
    openwiki-compatible/
      repo-memory-packet.json
      repo-memory-packet.md
      redaction-report-summary.json
    gitnexus/
      gitnexus-context-packet.json
      gitnexus-context-packet.md
      fresh-index-summary.json
      stale-index-summary.json
    review-dry-run-summary.json
```

The summary should include:

- target repo and PR number
- head SHA and base SHA
- packet versions and packet hashes
- byte and token estimates
- source counts and omitted-source reasons
- degraded-mode status
- redaction status
- dry-run review command name and exit status

Do not store raw private diffs, secrets, raw provider prompts, raw customer
logs, local credentials, cookies, or private keys in the evidence bundle.

`src/repo-wiki-packet.ts` exposes a library-only
`buildSupportedAddonDryRunPacket` helper for this bundle. It produces a
deterministic Markdown summary over the OpenWiki-compatible repo wiki packet and
GitNexus context packet, including:

- packet versions and SHA-256 hashes
- byte and token-ish estimates
- redaction status or redaction report hashes
- stale, missing, or unknown degraded-mode reasons
- related and omitted GitNexus context counts
- `runtimePromotion: false`
- `nativeToolExpansion: false`

That dry-run contract is intentionally not wired into `src/cli.ts`,
`src/config.ts`, `src/worker.ts`, active config, release docs, daemon state, or
GitHub App permissions. It is evidence for humans and agents to inspect before
any later feature-flagged runtime integration.

## Non-Goals

- Do not make OpenWiki or GitNexus required for v1.0 public launch.
- Do not fork or import OpenWiki source in this issue.
- Do not treat addon memory as more authoritative than the current PR diff,
  GitHub metadata, or checkout files.
- Do not use addon support to expand GitHub App permissions, live repo
  monitoring, provider/runtime configuration, daemon state, or release state.
- Do not claim CodeRabbit parity, public launch completion, enterprise
  readiness, or calibrated review quality from addon packet support alone.

## Readiness Checklist

- [ ] OpenWiki-compatible Markdown and JSON packet examples are documented.
- [ ] GitNexus context packet examples are documented.
- [ ] Shared addon contract includes source identity, freshness, byte/token
      caps, redaction status, provenance hash, and degraded-mode behavior.
- [ ] Fixture evidence proves missing or stale addons degrade gracefully.
- [ ] Review dry-run evidence proves packet context improves orientation without
      exceeding budget or leaking secrets.
- [ ] Agent-facing docs show how to discover and inspect addon packet commands.
- [ ] Related implementation remains linked to #122 and #82 without duplicating
      either issue's scope.
