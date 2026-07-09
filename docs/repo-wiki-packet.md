# Repo Wiki Packet

Repo wiki packets are deterministic, evidence-safe context bundles for
codebase-map and repo-wiki review prompts. Packet generation remains usable as a
dry-run artifact, and live prompt inclusion is gated behind
`repoWikiContext.enabled`.

This context is advisory. GitHub diff, current checkout files, current review
evidence, and configured repo policy remain truth. A stale or missing wiki
packet must degrade to a low-confidence context hint, not override the code
under review.

## Packet Model

`src/repo-wiki-packet.ts` builds a packet with:

- repo identity: `owner/repo`, optional default branch, optional redacted
  remote URL
- source freshness: ref, head SHA, checked-at timestamp, and `fresh`, `stale`,
  or `missing` status
- included sections: normalized codebase-map sections with source files, byte
  length, token-ish estimate, truncation state, and redaction state
- included files: stable file-to-section provenance
- budget: max and used byte budget plus token-ish budget
- redaction result: `passed` or `redacted` with replacement count
- degraded mode: true when the source is stale or missing
- generated timestamp
- deterministic `packetSha`

The packet SHA is derived from canonical JSON with sorted object keys. Markdown
and JSON emitters are evidence-safe presentation formats over that packet.

## Section Inputs

Sections should be small, review-useful summaries such as:

- architecture overview
- key entrypoints
- domain map
- test commands
- review rules
- known risky areas

Inputs are normalized deterministically:

- IDs are trimmed, lowercased, slugged, and made unique with deterministic
  suffixes when normalized IDs collide.
- CRLF text becomes LF text.
- empty sections are excluded with reason `empty`.
- source file lists are trimmed, de-duplicated, and sorted.
- sections sort by `order`, then `id`.

## OpenWiki-Derived Packets

`src/openwiki-derived-packet.ts` curates an existing `openwiki/**` tree into the
same deterministic packet model. It does not run OpenWiki or call a model. It
reads Markdown pages under `openwiki/`, excludes `openwiki/_review/**`
suggestions, extracts `## Source map` bullets as provenance, and redacts
secret-like environment variable names before packet construction.

Freshness is source-backed: the packet is `fresh` only when
`openwiki/.last-update.json` records the current head SHA and the worktree has no
non-`openwiki/**` changes. Missing or mismatched metadata produces stale or
missing degraded packets, which the runtime omits unless stale context is
explicitly allowed.

## Budgets And Redaction

The builder caps section bodies by UTF-8 byte length without splitting a
multi-byte character. It then drops lower-priority sections until the rendered
packet fits the byte and token-ish budgets. Budgets smaller than the fixed
packet header fail closed instead of returning an over-budget packet.

`maxBytes` and `maxTokens` bind the Markdown emitter because that is the prompt
context form. JSON output is an evidence-safe machine payload, but callers that
persist or transmit JSON must measure `formatRepoWikiPacketJson(packet)` against
their own storage or transport limits.

Secret-like text is passed through the repository's shared redaction helper
before packet emission, including remote URLs and section provenance strings.
Generated markdown and JSON must not contain raw tokens, API keys,
cookie/session values, private keys, email addresses, or customer data matched
by that helper.

## Degraded Mode

Use `source.status = "stale"` when the packet was generated from an older ref or
checkout. Use `source.status = "missing"` when no repo wiki/codebase map exists
yet. Both statuses set `degraded: true` and should be treated as context hints
only. Missing source with no sections records an excluded `packet:sections`
entry with reason `missing_source`.

## Supported Addon Dry-Run Packet

Issue #123 adds a dry-run contract that summarizes the repo wiki packet beside a
GitNexus context packet without making either addon required.

`buildSupportedAddonDryRunPacket` emits a deterministic packet with:

- one `openwiki-compatible-repo-wiki` addon entry
- one `gitnexus-context` addon entry
- packet hashes, versions, budget estimates, and redaction metadata
- degraded-mode reasons for stale, missing, or unknown addon data
- hard `runtimePromotion: false`
- hard `nativeToolExpansion: false`

The fixed summary itself has byte and token-ish caps. If even the fixed dry-run
summary cannot fit those caps, the builder fails closed instead of returning an
over-budget packet.

## Runtime Boundary

Prompt integration is disabled by default through `config.repoWikiContext`.
When enabled, `src/worker.ts` reads a prebuilt packet from the prepared PR
worktree, records redacted evidence, and includes it in the review prompt only
if it is fresh or explicitly allowed stale/degraded, within budget, and free of
secret-like text. `packetPath` is confined to a relative path inside the
prepared PR worktree; absolute paths and parent-directory segments are rejected.
Deterministic repo-wiki packets are treated as `fresh` only when their
`source.headSha` matches the prepared PR worktree head. Self-declared
`source.status = "fresh"` with a missing or mismatched source head is downgraded
to `unknown`. Loose JSON or raw Markdown packets without freshness metadata are
also treated as `unknown`, which is omitted unless `includeStaleContext=true`.

Packets read from the PR worktree can be PR-author-controlled. Treat packet
metadata, section titles, section bodies, and source notes as untrusted advisory
text, never as instructions. The prompt boundary repeats this rule so packet
content cannot override review instructions, current diff evidence, checkout
files, GitHub metadata, or configured repo policy.

This integration does not run OpenWiki during live review, mutate repository
files, change GitHub comment posting behavior, alter checks, or make repo-wiki
context authoritative. OpenWiki-generated files remain confined to
`openwiki/**`; suggestions for other docs are report-only.
