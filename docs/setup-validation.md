# Setup Validation Plan

This runbook defines the clean setup transcript plan for NeonDiff. It is a plan
for proving the first-run path; it is not a claim that setup has already been
fully proven.

The validation target is a literal pass through:

```text
install -> init -> doctor -> providers -> first dry-run review
```

For maintainer setup-readiness evidence, run this twice before attaching the
result to the relevant readiness tracker:

- human transcript: a human follows README and [docs/SETUP.md](SETUP.md)
  without hidden repo knowledge
- agent transcript: an AI coding agent follows README, [AGENTS.md](../AGENTS.md),
  and [docs/SETUP.md](SETUP.md) literally, recording every assumption

## Environment Contract

Use a clean machine, clean container, or clean macOS user/session. If that is
not available, use an isolated temp npm prefix plus fresh config, state, and
evidence directories outside the repository.

All command examples below assume these scratch paths are defined first:

```bash
export scratch_parent="${TMPDIR:-/tmp}"
export work_dir="${work_dir:-$(mktemp -d "$scratch_parent/neondiff-setup-validation.XXXXXX")}"
export tmp_prefix="$work_dir/npm-prefix"
mkdir -p "$tmp_prefix" "$work_dir/evidence"
```

Record:

- date and timezone
- OS and architecture
- Node.js and npm versions
- shell
- install path or temp npm prefix
- NeonDiff package version or source SHA
- GitHub App installation target
- provider path under test
- whether the provider is local/self-hosted or hosted
- repository, PR number, and head SHA used for the dry-run review

Do not record raw private keys, provider API keys, GitHub tokens, license keys,
raw customer data, or unredacted model transcripts.

Suggested local evidence root:

```text
$work_dir/evidence/setup-validation/YYYY-MM-DD/<human-or-agent>/
```

Maintainers can copy or link the sanitized transcript from that root into the
relevant GitHub issue or release evidence packet after the run completes.

## Transcript Format

Each transcript should be a Markdown file with this shape:

```markdown
# NeonDiff Setup Validation Transcript

- Runner:
- Environment:
- Package or SHA:
- GitHub App:
- Provider:
- Target repo:
- Target PR:
- Target head SHA:
- Start time:
- End time:
- Result: pass | blocked | failed

## Commands

For each command:

1. exact command
2. expected result from docs
3. observed result
4. sanitized output or artifact path
5. deviation, fix, or stop condition

## Proof Boundary

What this transcript proves and what it does not prove.
```

Keep long JSON output in separate files and link it from the transcript.

## Step 1: Install

Validate the package install path first. Use the version named by the docs or
the issue under test.

Public install proof currently means the npm package `neondiff@0.4.30-beta.1`.
Source-only beta releases `v0.4.31-beta.1` through `v0.4.37-beta.1` are held
from npm; validate those by source SHA or local build path, not by expecting a
new public npm artifact.

```bash
npm install -g neondiff@<version-under-test> --prefix "$tmp_prefix"
"$tmp_prefix/bin/neondiff" help
```

If validating the installer script, dry-run first:

```bash
curl -fsSL https://www.neondiff.com/install | sh -s -- --dry-run
```

Evidence to capture:

- `versions.txt`: `node --version`, `npm --version`, and NeonDiff version/help
- `install.log`: sanitized install output
- `install-dry-run.log`: installer dry-run output when used
- `path.txt`: resolved CLI path

Stop if install requires undocumented prerequisites, writes into the repo,
prints secrets, installs a different package/version than the docs name, or
cannot run `neondiff help`.

## Step 2: Init

Create a fresh config outside tracked repo files:

```bash
neondiff init --config "$work_dir/config.local.json"
```

Then edit only local, untracked values for:

- GitHub App id and private key path
- state path
- evidence path
- allowed pilot repos
- provider id and model path
- license settings when validating a private or commercial repo path

Provider keys and NeonDiff entitlements are separate inputs. Provider keys are
for model access; they are not proof that private-repo review is licensed.
Record whether the transcript is proving:

- public repo review on the default free path
- public repo review with `license.publicReposFree=false`
- private repo review with an active private entitlement

Do not treat a public-only entitlement as proof for a private repo path.

Evidence to capture:

- `init.log`: sanitized init output
- `config.redacted.json`: config with secrets and local private paths redacted
- `config.sha256`: hash of the redacted config
- `paths.txt`: state and evidence directories

Stop if init overwrites an existing file without confirmation, writes secrets
to tracked files, creates world-readable secret material, or leaves required
fields undocumented.

## Step 3: GitHub Doctor

Check GitHub App visibility before provider or review work:

```bash
neondiff doctor github --config "$work_dir/config.local.json" --json
```

Evidence to capture:

- `doctor-github.json`
- `github-installation.md`: selected repos, App slug/id if safe, and permission
  checklist

Expected shape:

- `ok` is true
- `github.readMode` is `app_installation`
- `github.canPostAsApp` matches the dry-run/live boundary under test
- every enabled repo appears in `github.readChecks[]`
- `activeRepoChecks` is greater than zero

Stop if the App cannot read the target repo, the target repo is not explicitly
selected, issue-enrichment permissions are enabled unintentionally, or the
doctor path requires a personal access token for the PR review path.

Issue enrichment is out of scope for this setup pass unless the transcript is
explicitly about that lane. PR review allowlists do not opt a repo into issue
enrichment, and enabling issue enrichment should not imply processing an
existing open-issue backlog by default.

## Step 4: Provider Readiness

List providers without calling models:

```bash
neondiff providers list --config "$work_dir/config.local.json" --json
```

Run provider doctor:

```bash
neondiff providers doctor --config "$work_dir/config.local.json" --json
```

For a single local OpenAI-compatible endpoint smoke, name the provider:

```bash
neondiff providers doctor \
  --config "$work_dir/config.local.json" \
  --provider <provider-id> \
  --smoke true \
  --json
```

For hosted BYOK endpoints, require an explicit operator decision before remote
smoke:

```bash
NEONDIFF_ALLOW_REMOTE_SMOKE=true \
  neondiff providers doctor \
    --config "$work_dir/config.local.json" \
    --provider <hosted-provider-id> \
    --smoke true \
    --json
```

Evidence to capture:

- `providers-list.json`
- `providers-doctor.json`
- `providers-smoke.json` when smoke is in scope
- `provider-egress.md`: local/self-hosted/hosted classification and what data
  was allowed to leave the worker

Stop if a provider check fans out to multiple authenticated hosted providers,
prints an API key, sends PR diffs during provider smoke, or requires hosted
egress when the run is supposed to be no-egress.

## Step 5: Full Doctor

Run the full readiness check after GitHub and provider checks:

```bash
neondiff doctor --config "$work_dir/config.local.json" --json
```

Evidence to capture:

- `doctor.json`
- `doctor-summary.md`: pass/fail fields and any docs mismatch

Stop if `ok` is false, repo policy skips the target unexpectedly, provider
readiness is unclear, or the output asks the runner to use undocumented flags.

## Step 6: First Dry-Run Review

Use a known repository, PR number, and current head SHA. Keep live posting off.

```bash
neondiff review-pr \
  --config "$work_dir/config.local.json" \
  --repo owner/name \
  --pr 123 \
  --dry-run true \
  --zcode false
```

Evidence to capture:

- `dry-run-review.json`
- `target-pr.md`: repo, PR number, base SHA, head SHA, and why this PR is safe
  for setup validation
- `evidence-manifest.txt`: files written by the dry-run evidence directory
- `redaction-check.md`: confirmation that saved artifacts do not contain
  private keys, provider API keys, GitHub tokens, license keys, or raw customer
  data

When validating a blocked private or commercial path, the expected result is an
early license gate before checkout, file listing, provider calls, or GitHub
review posting. Capture that path with:

- `license-gate.json` or equivalent redacted gate evidence
- `license-summary.md`: repo visibility, entitlement scope/status, and why the
  worker stopped before review execution

Stop if the command attempts to post a live review, uses `--dry-run false`,
cannot prove current head state, writes evidence into the repo, or produces
artifact names/fields the setup docs do not explain. Stop and file a docs or
product bug if a blocked private/commercial run reaches checkout, file listing,
provider setup, or posting before the license gate fires.

## Clean Setup Pass Criteria

A transcript can be attached as setup evidence only when:

- every command in the install -> init -> doctor -> providers -> first dry-run
  review path is present with exact command text
- every expected JSON output file exists and is parseable
- the target repo and PR are explicit
- the dry-run review did not post comments, reviews, labels, or branch changes
- blocked private/commercial proofs stop before checkout, file listing,
  provider calls, and review posting while still capturing license-gate
  evidence
- secrets are absent from transcript and evidence
- every deviation from README or docs/SETUP.md is listed as a docs bug or setup
  bug
- the proof boundary states exactly which OS, package/SHA, provider, repo, PR,
  and head SHA were tested

## Stop Conditions

Stop and file or update the tracked issue when any of these occur:

- install cannot run from the documented commands
- Node/npm requirements differ from docs
- `neondiff init` needs hidden local context
- GitHub App permissions or selected-repo install steps are missing or wrong
- provider setup requires storing a secret in tracked config
- hosted provider smoke runs without explicit remote-smoke consent
- dry-run review mutates GitHub
- evidence contains secrets or raw private/customer data
- commands require package/source changes outside the validation issue
- the runner cannot explain whether the failure is docs, environment, provider,
  GitHub App, or product behavior

## Proof Boundary

A completed transcript proves only that the documented first-run path worked
for the named environment, package or SHA, GitHub App installation, provider,
repository, PR, and head SHA. It does not prove GA readiness, all-platform
support, live-posting safety, provider quality, hosted BYOK behavior, release
readiness, desktop readiness, marketplace readiness, or calibrated review
accuracy.
