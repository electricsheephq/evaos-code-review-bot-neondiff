# Local checkout review

`review-local` posts nothing, needs no license activation, and makes no GitHub
calls. Reviewing private or internal code with it outside evaluation still needs
a paid license under [LICENSE.md](../LICENSE.md). It
uses the configured Codex CLI session, NeonDiff prompt, context budget and
deterministic findings gate. It opens no state database and runs no
self-consistency verifier. Model providers receive the review context.

review-local treats the checkout as trusted; run it only on code you would run Codex on directly. Unattended reviews of outside contributors' PRs belong in the daemon or `review-pr --ci`, which apply restricted mode.

```sh
neondiff review-local --repo-path ./checkout --base <base-sha> \
  --repo owner/name --pr-number 123 --title 'Change title' --out findings.json
```

`--head` defaults to checkout HEAD and must match it. `--diff-file` overrides
`git diff base...head`. Supply `--pr-json` instead of repo/number/title for
ReviewBench metadata including the body. `--format neondiff` writes final gate
comments; `--format reviewbench` writes the benchmark envelope atomically.
Use `--config`, `--model`, `--reasoning-effort`, `--checkout-reads true|false`,
and `--agent` to select settings. Codex is enabled by default. Evidence uses a
temporary directory; `--evidence-dir` selects its location and `--keep-evidence`
preserves it. Settings print to stdout before execution.

When checkout reads are enabled, commit or stash tracked and untracked changes, or use a clean detached worktree at the review head; ignored files such as `node_modules` are allowed.

For ReviewBench, use `review-local --reviewbench-env --format reviewbench`.
Inputs come from `RB_REPO` (default `/work/repo`), `RB_BASE`, `RB_HEAD`, `RB_DIFF`,
`RB_PR_JSON`, `RB_NWO`, `RB_PR_NUMBER`, `RB_OUT`, `RB_AGENT`, and settings from
`RB_CONFIG_MODEL`, `RB_CONFIG_REASONING`, `RB_CONFIG_CHECKOUT_READS`.

After building the repo, the sequential native runner (no Docker) is:

```sh
node scripts/reviewbench/run-local.mjs --reviewbench ./ReviewBench \
  --set test --limit 3 --run ./new-run --cache ./mirrors --arm neondiff \
  --model gpt-6.1-sol --reasoning-effort high --checkout-reads true
```

`--run` must not exist. `--pr` selects a zero-based corpus index; `--set full`
uses the full manifest. `--arm codex-native` uses one plain read-only Codex call
per PR with the same model and effort, without the NeonDiff gate. Both arms
write `findings/` and `runs.jsonl`; failed PRs are recorded and execution
continues. The runner does not judge results or establish a quality score.
