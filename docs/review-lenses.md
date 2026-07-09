# NeonDiff Review Lenses

Review lenses are default-off advisory context packets for trying review styles without widening
NeonDiff runtime permissions or changing posting gates.

They are not native ZCode skills. They do not enable tools, MCP, shell, web, memory, agents, writes,
GitHub comments, GitHub reviews, or `REQUEST_CHANGES`. The current PR diff, checkout files, schema
validation, current-head checks, redaction, and deterministic posting policy remain authoritative.

## Built-In Lenses

- `first_principles`: asks the reviewer to name desired function, hard constraints, soft
  assumptions, smallest proof, and negative risks.
- `architecture`: asks for boundary, contract, degraded mode, rollback needs, and proof needs.
- `decision`: maps evidence to `block`, `warn`, `accept_with_evidence`, `defer`, or
  `human_review` inside the outcome ledger only.
- `lean`: Ponytail-style minimality pressure with `delete`, `stdlib`, `native`, `yagni`, and
  `shrink` tags. Lean output is shadow evidence only and cannot block a PR.

## Surfaces

- `issue_enrichment`: first-principles and architecture sections can be added to planner packets.
  This uses the separate issue-enrichment allowlist and throttles; enabling a lens does not scan old
  backlog issues or widen PR review repos.
- `pr_shadow`: lean suggestions are recorded in evidence, not posted as blocking findings.
- `walkthrough`: reserved for future compact summaries after fixture/eval review.

## Dry-Run Eval Gate

Use `review-lenses-eval` before any live activation. The command compares
lens-enabled output against a no-lens baseline and writes redacted evidence only.
The output root must be fresh or empty so stale artifacts cannot affect the
scorecard. It does not flip `reviewLenses.enabled`, change public defaults, post
comments, alter GitHub permissions, widen monitored repos, mutate live config,
or promote the `walkthrough` surface.

Each scenario writes `manifest.json`, paired `baseline/` and `lens/` artifacts,
`diff-summary.json`, `redaction-report.json`, and `lens-scorecard.json`.

## Config Sketch

```json
{
  "reviewLenses": {
    "enabled": false,
    "packetVersion": "review-lens-packet-v0.1",
    "active": [
      { "id": "first_principles", "surface": "issue_enrichment", "mode": "summary" },
      { "id": "architecture", "surface": "issue_enrichment", "mode": "summary" },
      { "id": "lean", "surface": "pr_shadow", "mode": "shadow" }
    ],
    "maxLensBytes": 4000,
    "maxPacketBytes": 12000
  }
}
```

Keep `enabled:false` in public defaults. A live activation should start with dry-run evidence and a
manual comparison against no-lens output before any public walkthrough promotion.
