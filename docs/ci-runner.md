# CI Runner Guide

All `review-pr --ci` runs bypass the base-merge-only skip: CI state is temporary and the shared Actions bot identity is not a trusted prior-review anchor.

NeonDiff can run one-shot dry-run checks on Linux CI runners when you want PR
review evidence without a long-lived daemon. This guide covers GitHub Actions
and generic CI hosts. It does not grant extra GitHub permissions or bypass the
normal current-head checks.

## GitHub Actions

For NeonDiff 1.1.0, save the following as `.github/workflows/neondiff.yml`
on the default branch. Add your own `OPENAI_API_KEY` in repository or
organization Actions secrets. NeonDiff uses your model access and never pays
for or proxies model calls. Public repositories need no activation on this CI
path; private repositories also need the `NEONDIFF_LICENSE_KEY` secret described
below. Each license covers one GitHub organization or user account: Solo is
$9/mo or $90/yr, Team is $290/yr.

This workflow posts a current-head review when a PR opens or becomes ready,
or when an OWNER, MEMBER, or COLLABORATOR comments `/neondiff review` on a PR.
It never checks out PR code into the workflow job. NeonDiff fetches the diff and
uses its confined review checkout; repository contents remain untrusted input.
The separate `electricsheephq/neondiff-action` repository is not available yet;
this workflow uses the versioned CLI directly once 1.1.0 is published.

```yaml
name: NeonDiff review
on:
  pull_request_target:
    types: [opened, ready_for_review]
  issue_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  neondiff:
    if: >-
      github.event_name == 'pull_request_target' ||
      (github.event_name == 'issue_comment' &&
       github.event.issue.pull_request &&
       startsWith(github.event.comment.body, '/neondiff review') &&
       contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
        with:
          node-version: 26
      - run: npm install -g @openai/codex@0.163.0
      - name: Write private repository license file
        if: github.event.repository.private == true
        env:
          ACTION_LICENSE_KEY: ${{ secrets.NEONDIFF_LICENSE_KEY }}
        run: |
          install -m 600 /dev/null "$RUNNER_TEMP/neondiff-license-key"
          printf '%s' "$ACTION_LICENSE_KEY" > "$RUNNER_TEMP/neondiff-license-key"
          printf 'NEONDIFF_LICENSE_KEY_FILE=%s\n' "$RUNNER_TEMP/neondiff-license-key" >> "$GITHUB_ENV"
      - name: Review current PR head
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          MODEL: ${{ vars.NEONDIFF_MODEL }}
          EFFORT: ${{ vars.NEONDIFF_REASONING_EFFORT }}
        run: |
          if [ -n "$MODEL" ]; then export NEONDIFF_MODEL="$MODEL"; fi
          if [ -n "$EFFORT" ]; then export NEONDIFF_REASONING_EFFORT="$EFFORT"; fi
          npx --yes neondiff@1.1.0 review-pr --ci
```

Optionally set repository Actions variables `NEONDIFF_MODEL` and
`NEONDIFF_REASONING_EFFORT`; leaving them unset preserves CLI defaults.
Do not interpolate PR titles, bodies, or comment text into shell commands.
For a local non-posting development review, use [review-local](review-local.md).
The generic config-based dry-run path below still needs worker activation and
GitHub App credentials; it is separate from this CI path.

## Private repositories

For `review-pr --ci` (1.1.0+), one license covers one GitHub organization or
user account in CI, across all its repositories. Store the key in the Action
secret `NEONDIFF_LICENSE_KEY`. Write it in a separate step with these two shell
lines; only the file path is passed to NeonDiff:

```yaml
- name: Write NeonDiff license file
  env:
    ACTION_LICENSE_KEY: ${{ secrets.NEONDIFF_LICENSE_KEY }}
  run: |
    install -m 600 /dev/null "$RUNNER_TEMP/neondiff-license-key"
    printf '%s' "$ACTION_LICENSE_KEY" > "$RUNNER_TEMP/neondiff-license-key"
- run: neondiff review-pr --ci
  env:
    NEONDIFF_LICENSE_KEY_FILE: ${{ runner.temp }}/neondiff-license-key
```

These steps supplement the Action's normal GitHub token and provider setup.
The key file must be owned by the runner user with mode 0600; symlinks and
group/world-readable files are refused. Do not pass the key in NeonDiff argv
or environment variables. Private and internal repositories require activation
then live validation; unknown visibility fails closed. A missing key file
fails closed and names `NEONDIFF_LICENSE_KEY_FILE`. Public repositories make
no license call.

CI binds the seat to the stable numeric `GITHUB_REPOSITORY_OWNER_ID`, so owner
renames and fresh runners retain the same identity. HTTP 409 reports:
"this license is active for a different GitHub organization or account;
deactivate it there or use another license".
To free the seat, use a trusted secret-safe client to POST to the license API's
`/v1/license/deactivate` with the key and the **old owner's** machine ID:
base64url (without padding) of SHA-256 of `neondiff-ci:owner:` followed by that
numeric owner ID. License support can assist with this operation. Deleting the
Action secret or running local `license deactivate` does not free the CI owner
identity. Alternatively, use another license.

## Generic CI

The generic shape is:

```bash
node --version
npm install -g neondiff
cp config.example.json "$RUNNER_TEMP/config.local.json"
neondiff doctor github --config "$RUNNER_TEMP/config.local.json" --json
neondiff providers list --config "$RUNNER_TEMP/config.local.json" --json
neondiff review-pr \
  --config "$RUNNER_TEMP/config.local.json" \
  --repo owner/name \
  --pr "$PR_NUMBER" \
  --expected-config-revision "<verified-config-revision>" \
  --zcode true \
  --dry-run true
```

Use CI for one-shot checks. Use [docs/systemd.md](systemd.md) or
[docs/docker.md](docker.md) for a supervised long-running Linux worker.

Private and internal repository workflows require `contents: read` in addition to
review posting permissions. CI clone and fetch authentication uses `GITHUB_TOKEN`
only in the Git child environment; it is never written to the mirror config.
