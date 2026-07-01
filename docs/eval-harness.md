# Offline Eval Harness

The offline eval harness creates read-only comparison packets for the v0.2 CodeRabbit-class reviewer work. It does not call GitHub, post PR comments, mutate repos, or change launchd state.

Run it with a local scenario file:

```bash
npm run eval:offline -- --input /path/to/scenario.json
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
  "rawOutput": { "findings": [] },
  "botFindings": { "findings": [] },
  "labels": [
    {
      "source": "seeded_defect",
      "severity": "P1",
      "path": "Assets/Scripts/CombatTurn.cs",
      "line": 26,
      "title": "Combat health reset breaks active fights",
      "body": "Expected issue description."
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

## Packet Contents

Each packet includes:

- `manifest.json`
- `raw-output.json`
- `normalized-findings.json`
- `redaction-report.json`
- `duplicate-report.json`
- `comparison.csv`
- `labels.json`
- `calibration-report.json`
- `scorecard.json`

`scorecard.json` is the gate artifact. Thresholds are explicit and fail closed. The calibration report is intentionally marked `uncalibrated`; do not present public 95% confidence claims from these packets until enough labeled findings exist for measured reliability bins.
