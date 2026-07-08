# The Calibration Loop

This is the operator guide for closing NeonDiff's confidence-calibration loop:
observing what happened to posted findings, aggregating those outcomes into
empirical precision, and — under explicit human gates — feeding the evidence
back into configuration.

The design intent behind the loop is in [vision.md](vision.md). The short
version: NeonDiff only earns the right to display calibrated confidence by
measuring its own precision on your repos, and every automated step below is
built to make the review *quieter*, never louder.

## Loop Overview

```
review posts findings
        │
        ▼
1. outcome-observe        — label what actually happened per finding
        │
        ▼
2. calibration-aggregate  — labels → per-bin precision + Wilson lower bounds
        │
        ▼
2b. precision badge       — aggregate → Shields endpoint JSON, gray until gated
        │
        ▼
3. calibration-promote    — evidence numbers → reviewable config patch (human-gated)
        │
        ▼
4. manual human edit      — flipping publicDisplay.mode is never automated
```

Steps 1–3 and badge regeneration are CLI commands. Step 4 is deliberately not.

## 1. Observe Outcomes: `neondiff outcome-observe`

Revisits reviewed PRs after merge and records per-finding outcome labels
(revert, hotfix, merged fix, human thread, none observed) into the
`finding_outcome_labels` store.

```bash
neondiff outcome-observe \
  --input observer-input.json \
  --output-dir evidence/outcome-observe/$(date +%F)
```

- `--dry-run` defaults to **true**: the default invocation reads and reports
  without persisting labels. Pass `--dry-run false` to record.
- `--mark-negative-control` records an `explicit_control` label for a
  verifiably-clean run — a review that posted **zero** findings. It refuses any
  run that posted findings, and it requires `--dry-run false` because it
  writes. Negative controls are never inferred from missing labels; a clean
  run only counts when you explicitly mark it.

### Scheduling the loop (daemon-integrated observation)

The observe step above is a manual CLI. To run it hands-off, the review daemon
can perform a bounded, read-only observe pass at the tail of each scheduled
cycle. It is **additive and default-off** — enable it under `calibrationLoop`:

```jsonc
{
  "calibrationLoop": {
    "observeSchedule": {
      "enabled": true,          // default false ⇒ zero observer work, zero extra GitHub reads
      "intervalMinutes": 720,   // minimum spacing between observe passes (global gate)
      "maxPullsPerCycle": 25,   // upper bound on heads observed per cycle
      "perRepoCooldownMinutes": 720, // skip a repo observed within this window
      "lookbackDays": 14        // only consider findings recorded within this window
    }
  }
}
```

When enabled and due, the pass selects recently-recorded review findings within
`lookbackDays`, groups them by `(repo, pull, head)`, skips repos still inside
`perRepoCooldownMinutes`, caps the batch at `maxPullsPerCycle`, reads each PR's
merge state read-only, derives outcome labels via the same precedence resolver
as the CLI, and records them into `finding_outcome_labels`. It writes a redacted
`calibration-observe.json` evidence packet. It **never** aggregates, promotes,
mutates config, switches the public display, or posts to GitHub — those stay
manual, human-gated steps. A failure in the pass never disturbs the review
cycle.

**Observation source — the findings ledger.** Reconstructing an outcome needs
each finding's path and line. Every posted review therefore records its findings
into a `review_findings` ledger (fingerprint, repo, pull, head, path, line,
severity, category, confidence — **never title or body text**, all fields already
public in the posted review). This write is **best-effort and fail-open**: if it
throws, the review still posts — observation bookkeeping never gates a review.

**Bootstrap note.** The scheduled pass can only observe findings recorded into
`review_findings` *after this ships*. PRs reviewed before the ledger existed are
invisible to the scheduled pass; use the manual `outcome-observe` CLI to backfill
them if needed.

## 2. Aggregate Labels: `neondiff calibration-aggregate`

Reads accumulated outcome labels from the state DB and produces
`aggregate-calibration.json` plus an evidence packet: labeled-finding counts,
P0/P1 label counts, explicit negative-control counts, and per-confidence-bin
empirical precision with Wilson lower bounds (the same statistics the offline
eval harness computes — see [eval-harness.md](eval-harness.md)).

```bash
neondiff calibration-aggregate \
  --config config.local.json \
  --output-dir evidence/calibration-aggregate/$(date +%F)
```

This step is read-only with respect to behavior: it evaluates the
public-confidence floors and reports eligibility, but never mutates config and
never switches the public display.

### Regenerating The Precision Badge Endpoint

After each aggregate run, regenerate the static Shields endpoint JSON:

```bash
mkdir -p docs/badges
neondiff badge \
  --config config.local.json \
  --output docs/badges/precision.json
```

The badge command is safe to run before calibration is earned. When the
aggregate is empty, below the public-confidence gate, or still paired with
`confidenceCalibration.publicDisplay.mode: "uncalibrated"`, the endpoint must
remain gray with a `calibrating (n=...)` message. A public percentage can appear
only when the aggregate passes the same floors listed below and a human has
manually flipped public display mode to `"calibrated"`.

The generated JSON is self-attested evidence, not a third-party benchmark: it
reports what NeonDiff's own calibration aggregate currently proves. The
generator is deliberately un-inflatable by tooling: it does not accept a
percentage override, does not write public display mode, and must fall back to
gray when the proof boundary is not met. Treat manual edits that add or raise a
percentage as invalid; regenerate from the aggregate instead. See
[precision-badge.md](precision-badge.md) for the public README snippet and
review rules.

## 3. Promote Evidence: `neondiff calibration-promote`

Consumes the aggregate and, only when the evidence passes every floor, writes
the calibration **numbers** as a reviewable config patch.

```bash
neondiff calibration-promote \
  --input evidence/calibration-aggregate/<date>/aggregate-calibration.json \
  --output-dir evidence/calibration-promote/$(date +%F) \
  --confirm
```

- `--confirm` is required; without it the command refuses to run.
- Below-threshold evidence is refused with the failing gate named — nothing is
  written.
- The default output is a **patch file** (`calibration-config-patch.json`)
  that you inspect and apply by hand.
- `--apply` writes the same numbers directly and additionally requires
  `--i-understand-live-config` (a deliberate double flag).
- Under **no** flag does the tool write `confidenceCalibration.publicDisplay.mode`.
  The patch carries the evidence numbers only.

## 4. The Human Flip

Public confidence display stays `uncalibrated` (numbers redacted from public
surfaces) until all of the hard floors hold:

| Floor | Minimum |
|---|---|
| `labeledFindings` | 100 |
| `p0p1Labels` | 30 |
| `negativeControlScenarios` (explicit only) | 10 |
| `wilsonLowerBound` | 0.95 |

When the promoted numbers meet the floors, a human — not a tool — edits
`confidenceCalibration.publicDisplay.mode` to `"calibrated"`. Config
validation enforces the floors again at load and fails closed, so a premature
flip is rejected even if made by hand. See
[neondiff-config.md](neondiff-config.md) for the full key reference and
[evals/confidence-calibration.md](evals/confidence-calibration.md) for the
calibration policy behind the floors.

## Feeding Ranking: `reviewGate.categoryPrecisionFloors`

The aggregate report also shows precision per finding category. When a
category's measured precision is low, set a confidence floor for it under
`reviewGate.categoryPrecisionFloors`:

```json
{
  "reviewGate": {
    "categoryPrecisionFloors": { "observability": 0.8 }
  }
}
```

A finding in a listed category loses `REQUEST_CHANGES` eligibility when its
confidence is below the configured floor — it still posts as a comment; only
the review event is demoted. A floor of `0` never demotes; `1` demotes
everything below full confidence. Nothing reads the aggregate at review time,
so the config file remains the single inspectable source of gate behavior.
Unknown category keys are rejected at config load.

## Invariants

- **Quieter-only.** Every consumer of calibration evidence (confidence floors,
  category precision floors, self-consistency refutation) demotes or
  suppresses. Nothing learned ever escalates a review event or promotes a
  finding.
- **Human-gated writes.** Automated steps write evidence and patch files;
  live-config changes require explicit double confirmation, and the calibrated
  display flip is manual, always.
- **Explicit controls only.** Unmeasured is not clean. Negative-control credit
  requires a deliberate `--mark-negative-control` on a zero-finding run.
- **Redaction everywhere.** All evidence files are written through secret
  redaction, like every other NeonDiff evidence surface.
