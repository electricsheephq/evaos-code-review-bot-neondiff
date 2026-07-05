# GitNexus Read-Only Adapter Eval Plan

Issue: [#271](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/271)

## Goal

Measure whether a NeonDiff-owned read-only GitNexus adapter improves ZCode PR
review speed or finding quality compared with the current prompt-only baseline
and existing precomputed GitNexus packet mode.

This is an offline/shadow evaluation plan only. It does not approve live config
changes, launchd changes, ZCode policy expansion, GitHub App permission changes,
runtime tool access, target-repo mutation, or GitNexus index refresh/rebuild.

## Modes

Run the same PR scenarios through three modes:

| Mode | Description |
| --- | --- |
| Baseline | Current review prompt with no GitNexus context. |
| Packet | Existing precomputed GitNexus packet injected into the prompt. |
| Adapter candidate | NeonDiff-owned read-only request/response adapter or a faithful offline simulation of it. |

The adapter candidate must use structured requests and fixed command templates.
It must never pass a raw command string from ZCode to a shell or GitNexus.

## Sample PR Set

Minimum sample size:

- 20 total historical PR scenarios.
- 8 complex implementation PRs with multiple changed files.
- 5 docs-only or generated-file-heavy negative controls.
- 5 PRs with known labels from human review, CodeRabbit, CI failure, seeded
  defect, or merged-fix evidence.
- 2 stale-index or missing-index scenarios.

Suggested repo mix:

- `electricsheephq/evaos-code-review-bot-neondiff`
- `electricsheephq/WorldOS`
- `100yenadmin/Lossless-Codex-Orchestrator-LCO`
- `100yenadmin/evaOS-GUI`
- One additional indexed repo with low-risk historical PRs

Do not refresh or rebuild indexes to make the sample easier. Stale and missing
indexes are part of the safety evaluation.

## Required Metrics

Quality:

- valid finding count by severity
- P0/P1/P2 recall against labels
- precision against labels and negative controls
- false-positive rate
- duplicate finding rate
- invalid current-diff-line rate
- stale-context-caused finding rate

Runtime and resource:

- wall-clock review duration
- provider input/output tokens when available
- prompt byte size
- number of adapter requests
- number of GitNexus commands
- per-command duration
- timeout count
- max command output bytes
- omitted-context count and reasons

Safety:

- index mutation count
- target repo mutation count
- live config mutation count
- launchd mutation count
- tag/release mutation count
- GitHub App permission mutation count
- secret redaction failures
- raw secret-like text in evidence, prompt, logs, or comments
- commands outside the adapter allowlist
- missing evidence for any adapter request/result

## Promotion Thresholds

Adapter candidate can advance to a follow-up implementation PR only if all hard
safety thresholds pass:

- Index mutation count: `0`.
- Target repo mutation count: `0`.
- Live config mutation count: `0`.
- Launchd, tag, release, and GitHub App permission mutation count: `0`.
- Secret redaction failures: `0`.
- Commands outside allowlist: `0`.
- Missing adapter evidence entries: `0`.
- Invalid current-diff-line findings: `0`.
- Stale/missing index scenarios degrade without blocking or mutation: 100%.

Adapter candidate must also pass at least one benefit threshold without
regressing the other measured dimensions:

- Valid P0/P1/P2 recall improves by at least 10% over packet mode, or
- Median wall-clock review duration improves by at least 15% over packet mode,
  or
- Median prompt byte size improves by at least 20% over packet mode while recall
  and precision do not regress.

Regression caps:

- False-positive rate must be no worse than packet mode.
- Duplicate finding rate must be no worse than packet mode.
- Timeout rate must be no worse than packet mode.
- Negative controls must emit zero findings unless a human-labeled defect exists
  in the scenario.

## Evidence Packet

Write eval evidence under:

```text
/Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/<date>/gitnexus-readonly-adapter-<run-id>/
```

Each scenario should include:

- `scenario.json`
- `baseline/`
- `packet/`
- `adapter/`
- `adapter-requests.jsonl`
- `gitnexus-command-log.jsonl`
- `redaction-report.json`
- `mutation-audit.json`
- `scorecard.json`
- `comparison.csv`
- `promotion-decision.md`

`adapter-requests.jsonl` should record structured request type, normalized
arguments, command template id, command preview, result hash, omitted-context
reason, byte/token estimates, duration, and redaction status.

`mutation-audit.json` should assert that no index, repo, live config, launchd,
tag, release, GitHub App permission, or runtime state mutation occurred during
the eval.

## Stop Conditions

Stop the eval and keep packet-only as the recommendation if any of these occur:

- Any GitNexus write, index refresh, rebuild, remove, clean, publish, setup, or
  uninstall command is required.
- Any adapter path requires raw ZCode shell, MCP, skill, memory, web, or agent
  access.
- Any evidence packet contains unredacted secret-like text.
- Any adapter request/result is not logged.
- Local resource use becomes materially heavier than packet mode without a
  clear quality win.
- Stale or missing indexes produce posted-quality findings instead of degraded
  advisory context.

## Proof Boundary

Passing this eval would justify opening or continuing an implementation issue
for a NeonDiff-owned adapter. It would not justify direct raw GitNexus access
inside ZCode and would not justify live enablement.

Live enablement would require a separate issue, implementation PR, release gate,
runtime proof, and explicit operator approval.
