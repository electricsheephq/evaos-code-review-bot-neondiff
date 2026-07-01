# Offline Eval Harness

The offline eval harness creates read-only comparison packets for the v0.2 CodeRabbit-class reviewer work. It does not call GitHub, post PR comments, mutate repos, or change launchd state.

Run it with a local scenario file:

```bash
npm run eval:offline -- --input /path/to/scenario.json
```

Run the checked-in local suite fixtures:

```bash
npm run eval:suite -- \
  --input-dir tests/fixtures/eval-suite-scenarios \
  --output-root /Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/$(date +%F)/local-suite
```

By default, packets are written under:

```text
/Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/<date>/<run-id>/
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

Supported label sources:

- `coderabbit`
- `human`
- `ci_failure`
- `merged_fix`
- `seeded_defect`

Negative controls use an empty `labels` array. The run passes only when the bot also emits no findings, unless thresholds are intentionally loosened for exploratory scoring.

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

`scorecard.json` is the gate artifact. Thresholds are explicit and fail closed. The calibration report is intentionally marked `uncalibrated`; do not present public 95% confidence claims from these packets until enough labeled findings exist for measured reliability bins.

`manifest.json` records the effective thresholds, scenario mode, optional
scenario source, artifact inventory with SHA-256 digests, metadata counts, and
the proof boundary. The harness rejects output directories inside the active git
checkout so eval packets do not mutate the repo being evaluated.
