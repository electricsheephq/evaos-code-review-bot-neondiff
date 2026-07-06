# Advanced Outcome Modes

NeonDiff's next step is not to replace the stable reviewer. It is to add
measured advanced modes that can prove they save time, catch regressions, and
improve agent handoffs before they affect live review behavior.

## Stable Default

- `stable` remains the default live behavior.
- Advanced work starts as dry-run/evidence-only.
- Live launchd config, PR allowlists, issue-enrichment allowlists, provider
  retry behavior, and posting policy must not change from this lane unless a
  later release explicitly promotes a proven mode.

## Modes

- `advanced_dry_run`: computes outcome ledger, mode decision, timing, and
  scorecard evidence without posting comments.
- `advanced_pr_review`: later opt-in PR review mode for selected repos or PRs.
- `advanced_issue_research`: later opt-in issue enrichment mode with separate
  issue allowlist, repo throttles, and triggered research only.
- `advanced_full`: deferred combined mode after separate PR and issue pilots
  pass.

## Build Order

1. [#267](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/267)
   Outcome Ledger dry-run.
2. [#266](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/266)
   review mode router and GLM budget evidence.
3. [#264](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/264)
   weekly outcome scorecard fixtures/report.
4. [#261](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/261)
   advanced issue planner/research packet.

Sprint tracker:
[#269](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/269).
Parent tracker:
[#260](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/260).

## Outcome Ledger

The first artifact is an internal ledger for high-risk or AI-written PRs. It
captures:

- source issue or PR intent;
- base and head SHA;
- changed artifacts;
- evidence records;
- risk claims;
- proof gaps;
- safety gates;
- reviewer decision;
- GLM/runtime metrics when available;
- post-merge outcome placeholder.

The ledger is internal evidence. Public comments stay compact and redacted.

## Weekly Routine

Codex automation `neondiff-weekly-outcome-scorecard` runs weekly on Sunday. It
should inspect #260/#269 and child issues, generate or update a scorecard
packet, and comment with:

- current PR review score;
- current issue-enrichment score;
- confidence trend toward 95;
- timing, queue, and GLM/provider evidence;
- useful findings, misses, and false-positive drag when labeled;
- advanced-mode progress;
- next recommended experiment.

If the scorecard CLI does not exist yet, the automation produces a manual
read-only packet from GitHub issues, PRs, and existing evidence. It must not
mutate live config or post PR reviews.

## Proof Boundary

The current outcome scorecard is advisory at 90.2/100 confidence. Weekly
iterations may raise or lower that confidence based on evidence. This lane must
not claim CodeRabbit, ClawSweeper, or Looper parity, production readiness, or
95% calibrated review accuracy until labeled evals support that claim.
