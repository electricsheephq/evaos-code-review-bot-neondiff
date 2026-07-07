# Swift CodeQL Policy

Swift CodeQL is release/security evidence for NeonDiff Desktop. It is not the
inner PR iteration loop.

## Durable Decision

- Required PR velocity gate: `.github/workflows/swift-desktop-gate.yml`.
- Swift security-analysis workflow: `.github/workflows/codeql-swift-path-aware.yml`.
- Trigger policy: `workflow_dispatch` and weekly schedule only.
- PR/push policy: no `pull_request` or `push` trigger in the Swift CodeQL
  workflow.
- Upload policy: keep `upload: false`, `upload-database: false`, and
  `wait-for-processing: false` while the repository uses GitHub CodeQL default
  setup for non-Swift languages.
- Default setup policy: GitHub default setup may remain configured for actions
  and JavaScript/TypeScript, but it must not list Swift.

This keeps Swift CodeQL from blocking every Swift-source PR while preserving a
manual/scheduled security proof lane before signed release or GA.

## Current Measurements

- Swift CodeQL PR run
  [28882286388](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/28882286388)
  took 25m58s and failed after the manual SwiftPM build spent about 23m11s.
  The failure was SARIF upload rejection while repository default CodeQL setup
  was enabled.
- Earlier Swift CodeQL PR runs on 2026-07-07 ranged from roughly 18m26s to
  49m25s including canceled runs.
- The split Swift Desktop Gate on #419 completed the current-head impact,
  macOS smoke, and final gate in about 10s, 44s, and 4s respectively.

- Current main/manual measurement
  [28886926047](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/actions/runs/28886926047)
  on `5840b2d4bd6d6ef4cce6f99f149f5aa4c4f22e1f` completed successfully in
  about 25m48s. The job ran from 17:48:10Z to 18:13:52Z on 2026-07-07; manual
  SwiftPM build ran from 17:49:41Z to 18:12:11Z, about 22m30s. CodeQL analysis
  itself ran for about 1m16s. The run was dispatched against `main` before this
  policy was merged, so it is current budget evidence, not immutable release-tag
  evidence.

## Required Release Check

Before a signed desktop release or GA cut:

1. Verify default setup does not list Swift:

   ```bash
   gh api repos/electricsheephq/evaos-code-review-bot-neondiff/code-scanning/default-setup \
     --jq '{state,languages,query_suite,updated_at}'
   ```

2. Run the Swift CodeQL workflow on the immutable release tag:

   ```bash
   gh workflow run codeql-swift-path-aware.yml \
     -R electricsheephq/evaos-code-review-bot-neondiff \
     --ref <immutable-release-tag>
   ```

3. Verify the workflow run `headSha` equals the exact source SHA in the release
   record before using it as release evidence. If the tag does not exist yet and
   the workflow is dispatched against a branch for preflight only, record that as
   provisional evidence and rerun against the immutable tag before GA or signed
   distribution.

4. Record the run URL, conclusion, duration, `headSha`, and proof boundary in
   the release packet.

5. Stop the release only when the run finds an actual security issue, fails to
   initialize/build/analyze the release source, or the repo has no replacement
   Swift security-analysis evidence. Do not block ordinary PRs on advisory
   upload limitations.

## Budget

The workflow has a 35-minute job timeout. If a manual/scheduled run exceeds that
budget, treat it as a release-security investigation item, not a PR velocity
blocker. Keep the Swift Desktop Gate responsible for fast PR feedback.

## Future Conversion

Only enable Swift CodeQL SARIF upload after a tracked decision converts the repo
from default setup to compatible advanced CodeQL configuration, or after GitHub
supports the intended mixed default/advanced shape for this repository. That
change needs its own issue, PR, release evidence, and code-scanning proof.
