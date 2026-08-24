# Offline Eval Harness

The offline eval harness creates read-only comparison packets for the v0.2 CodeRabbit-class reviewer work. It does not call GitHub, post PR comments, mutate repos, or change launchd state.

Use an external evidence root for every run. The source default is
`$HOME/.neondiff/evidence`; set `NEONDIFF_EVIDENCE_ROOT` for CI or another
operator-owned location outside this checkout. These packets are offline,
advisory evidence only and must not be presented as hosted, runtime, or GA
proof.

```bash
export NEONDIFF_EVIDENCE_ROOT="${NEONDIFF_EVIDENCE_ROOT:-$HOME/.neondiff/evidence}"
case "$NEONDIFF_EVIDENCE_ROOT" in /*) ;; *) echo "NEONDIFF_EVIDENCE_ROOT must be absolute" >&2; exit 2 ;; esac
test -d "$NEONDIFF_EVIDENCE_ROOT" || { echo "create the external evidence root first" >&2; exit 2; }
NEONDIFF_EVIDENCE_ROOT="$(cd "$NEONDIFF_EVIDENCE_ROOT" && pwd -P)" || { echo "cannot canonicalize evidence root" >&2; exit 2; }
REPO_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)" || { echo "cannot canonicalize checkout root" >&2; exit 2; }
case "$NEONDIFF_EVIDENCE_ROOT/" in "$REPO_ROOT/"*) echo "evidence root must be outside the checkout" >&2; exit 2 ;; esac
EVAL_DATE="$(date +%F)"; EVAL_RUN_ID="replace-with-unique-run-id"; case "$EVAL_RUN_ID" in ""|"."|".."|*[!A-Za-z0-9._-]*) echo "EVAL_RUN_ID must be a portable path segment" >&2; exit 2 ;; esac
EVAL_DATE_ROOT="$NEONDIFF_EVIDENCE_ROOT/$EVAL_DATE"; test -e "$EVAL_DATE_ROOT" || mkdir "$EVAL_DATE_ROOT" || exit 2
EVAL_DATE_ROOT="$(cd "$EVAL_DATE_ROOT" && pwd -P)" || { echo "cannot canonicalize eval date root" >&2; exit 2; }
case "$EVAL_DATE_ROOT/" in "$NEONDIFF_EVIDENCE_ROOT/"*) ;; *) echo "eval date root escaped evidence root" >&2; exit 2 ;; esac
case "$EVAL_DATE_ROOT/" in "$REPO_ROOT/"*) echo "eval date root must be outside the checkout" >&2; exit 2 ;; esac
EVAL_PACKET_ROOT="$EVAL_DATE_ROOT/$EVAL_RUN_ID"; mkdir "$EVAL_PACKET_ROOT" || exit 2
EVAL_PACKET_ROOT="$(cd "$EVAL_PACKET_ROOT" && pwd -P)" || { echo "cannot canonicalize eval packet root" >&2; exit 2; }
case "$EVAL_PACKET_ROOT/" in "$EVAL_DATE_ROOT/"*) ;; *) echo "eval packet root escaped date root" >&2; exit 2 ;; esac
case "$EVAL_PACKET_ROOT/" in "$REPO_ROOT/"*) echo "eval packet root must be outside the checkout" >&2; exit 2 ;; esac
```

Run it with a local scenario file:

```bash
npm run eval:offline -- --input /path/to/scenario.json \
  --output-dir "$EVAL_PACKET_ROOT/offline"
```

Run the checked-in local suite fixtures:

```bash
EVAL_SUITE_ROOT="$EVAL_PACKET_ROOT/local-suite"
mkdir "$EVAL_SUITE_ROOT" || exit 2
npm run eval:suite -- \
  --input-dir tests/fixtures/eval-suite-scenarios \
  --output-root "$EVAL_SUITE_ROOT"
```

Run the paired sticky-vs-cold fixture:

```bash
npm run eval:sticky-vs-cold -- \
  --input tests/fixtures/sticky-vs-cold/seeded_quality_packet.json \
  --output-root "$EVAL_PACKET_ROOT/sticky-vs-cold-seeded-quality"
```

Run the repo-wiki context A/B gate with a fixture that contains baseline,
deterministic repo-wiki, and curated OpenWiki-derived findings:

```bash
npx tsx src/cli.ts eval-repo-wiki-context-ab \
  --input /path/to/repo-wiki-context-ab.json \
  --output-root "$EVAL_PACKET_ROOT/eval-gates/ab"
```

Run the suggest-only OpenWiki docs-drift gate:

```bash
npx tsx src/cli.ts eval-openwiki-docs-drift \
  --input /path/to/docs-drift.json \
  --output-root "$EVAL_PACKET_ROOT/eval-gates/docs-drift"
```

Both OpenWiki gates are offline evidence generators. They do not call a model,
post GitHub comments, enable the daemon, add cron, or edit production docs. The
docs-drift gate may write a `suggested-doc-edits.md` evidence artifact under the
chosen `--output-root`; treat that file as a review packet, not as a repository
documentation change.

Run the review-lenses dry-run comparison gate:

```bash
npx tsx src/cli.ts review-lenses-eval \
  --input-dir tests/fixtures/review-lenses-eval \
  --output-root "$EVAL_PACKET_ROOT/review-lenses-eval-gate" \
  --dry-run true
```

This command follows the same packet discipline: output stays outside the
checkout, the output root must be fresh or empty, artifacts are redacted,
thresholds are explicit, and the decision is advisory-only until a separate
live activation promotion gate passes.

The suite command exits non-zero when any scenario fails, when two scenarios use
the same `runId`, when a `runId` is not a safe path segment, or when any required
suite is missing from the input directory.

By default, packets are written under the external root selected by
`NEONDIFF_EVIDENCE_ROOT` (or `$HOME/.neondiff/evidence` when unset):

```text
$NEONDIFF_EVIDENCE_ROOT/$EVAL_DATE/$EVAL_RUN_ID/
```

Use `--output-dir` for tests or scratch runs.

## Scenario Shape

```json
{
  "evalName": "evaos-zcode-review-bot-comparison-v0.1",
  "runId": "seeded-combat-regression",
  "repo": "electricsheephq/WorldOS",
  "pullNumber": 1234,
  "headSha": "abc123",
  "suite": "seeded_defect_recall",
  "mode": "gating",
  "scenarioSource": {
    "path": "tests/fixtures/eval-suite-scenarios/seeded_defect_recall.json",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "rawOutput": { "findings": [] },
  "botFindings": { "findings": [] },
  "inlinePreviews": [
    {
      "path": "Assets/Scripts/CombatTurn.cs",
      "line": 26,
      "side": "RIGHT",
      "severity": "P1",
      "title": "Inline preview title",
      "body": "Redacted comment body preview."
    }
  ],
  "ciMetadata": [
    {
      "provider": "github-actions",
      "name": "test",
      "status": "failure",
      "conclusion": "Relevant check summary",
      "url": "https://github.com/org/repo/actions/runs/1"
    }
  ],
  "mergedFixes": [
    {
      "repo": "electricsheephq/WorldOS",
      "pullNumber": 1205,
      "mergeSha": "abc123",
      "path": "Assets/Scripts/CombatTurn.cs",
      "summary": "Fix diff used as historical label evidence."
    }
  ],
  "labels": [
    {
      "source": "seeded_defect",
      "severity": "P1",
      "path": "Assets/Scripts/CombatTurn.cs",
      "line": 26,
      "title": "Combat health reset breaks active fights",
      "body": "Expected issue description.",
      "sourceId": "seed-combat-health-reset",
      "sourceUrl": "https://github.com/org/repo/pull/123#discussion_r1",
      "author": "coderabbitai",
      "checkName": "test",
      "mergeSha": "abc123",
      "diffSummary": "Human-readable merged-fix evidence."
    }
  ],
  "thresholds": {
    "minPrecision": 0.8,
    "minRecall": 0.6,
    "minSeededRecall": 1,
    "maxSecretFindings": 0,
    "maxDuplicateFindings": 0
  }
}
```

Supported suites:

- `canary_shadow`
- `historical_pr_replay`
- `seeded_defect_recall`
- `safety_redaction`
- `duplicate_suppression`

Sticky-vs-cold scenarios are paired wrappers around normal offline scenarios.
They run one cold packet and one sticky packet for the same repo, PR, head SHA,
suite, and expected label baseline, then write side-by-side deltas and a
conservative decision. They do not enable public confidence percentages; the
default output is `advisory` unless the sticky packet regresses safety/quality
gates or enough measured runtime-safe evidence exists.

The current CLI accepts one paired scenario at a time, so normal single-run
packets cannot reach `runtime_safe_candidate` with the default evidence-volume
thresholds. That stronger decision is reserved for a future batch/aggregate
runner or an explicitly configured evidence packet that proves enough paired
scenarios, labels, negative controls, provider-attempt observations, and fresh
sticky context. Fresh sticky context requires both `staleContext: false` and a
`repoMemoryAgeSeconds` value no older than the default 24-hour freshness cap;
missing age evidence keeps the result advisory-only.

The sticky-vs-cold output root must be empty before a run starts. The runner
rejects non-empty roots instead of deleting them, so stale artifacts cannot
survive into a new evidence packet and the CLI cannot accidentally remove a
broader eval directory.

An empty label set is never counted as negative-control evidence by itself, on
either the offline or the sticky-vs-cold path. A scenario earns negative-control
credit only when it explicitly sets `negativeControl: true`; an unlabeled
scenario without the flag earns zero calibration credit of any kind. Declared
negative controls may not include expected labels.

Supported label sources:

- `coderabbit`
- `human`
- `ci_failure`
- `merged_fix`
- `seeded_defect`

Negative controls set `negativeControl: true` and use an empty `labels` array
(the flag, not the empty array, is what grants credit). In sticky-vs-cold
packets, a declared negative control only counts and only passes when both cold
and sticky packets emit zero findings, even when the inner packets use
exploratory thresholds.

`mode` defaults to `gating`. Gating scenarios may tighten thresholds, but cannot
silently loosen below the harness defaults. Use `mode: "exploratory"` for scout
or negative-control runs that intentionally set lower precision/recall gates.

## Packet Contents

Each packet includes:

- `manifest.json`
- `raw-output.json`
- `normalized-findings.json`
- `inline-previews.json`
- `ci-metadata.json`
- `merged-fixes.json`
- `redaction-report.json`
- `duplicate-report.json`
- `comparison.csv`
- `labels.json`
- `calibration-report.json`
- `scorecard.json`

`scorecard.json` is the scenario gate artifact. Thresholds are explicit and fail
closed. The calibration report is intentionally marked `uncalibrated`; do not
present public 95% confidence claims from these packets until enough labeled
findings exist for measured reliability bins. Calibration bins include empirical
precision and Wilson lower bounds, but public display remains `uncalibrated`
until the public-display policy is satisfied.

`eval-suite` also writes two root artifacts under `--output-root`:

- `suite-summary.json`
- `promotion-decision.md`

`promotion-decision.md` is the human-readable proof boundary for #8/#26/#85. It
must say whether calibrated public confidence remains disabled, why, and what
evidence is missing before any stronger confidence display can be considered.

`eval-sticky-vs-cold` writes paired packet artifacts under `--output-root`:

- `cold/` normal offline eval packet
- `sticky/` normal offline eval packet
- `sticky-vs-cold-summary.json`
- `sticky-vs-cold-report.md`

The sticky-vs-cold summary compares precision, recall, seeded recall, true/false
positives, false negatives, schema drops, duplicate findings, secret findings,
and optional runtime metrics such as provider attempts, latency, and token
counts. The wrapper rejects different cold/sticky expected labels and fails
closed when sticky recall, seeded recall, false negatives, false positives,
secret findings, duplicate findings, or schema drops regress beyond the
non-loosenable default policy. The decision is:

- `not_enough_evidence` when sticky fails packet gates or regresses configured
  safety/quality thresholds, misses a label matched by the cold baseline, or
  contains any secret-like finding.
- `advisory` when the paired comparison is clean but measured evidence is still
  too small for runtime-safe promotion.
- `runtime_safe_candidate` only when paired scenarios, labels, P0/P1 labels,
  negative controls, provider-attempt evidence, explicit fresh sticky context,
  and repo-memory age evidence meet the configured thresholds. With the current
  single-input CLI, this requires future batch aggregation; caller-provided
  sticky-vs-cold thresholds cannot loosen the default promotion policy or
  freshness cap, and this must not be used as a public calibrated-confidence
  claim.

`manifest.json` records the effective thresholds, scenario mode, optional
scenario source, artifact inventory with SHA-256 digests, metadata counts, and
the proof boundary. The harness rejects output directories inside the active git
checkout so eval packets do not mutate the repo being evaluated.
