# Contributing

Thanks for helping make NeonDiff useful, safe, and honest. NeonDiff is a
source-available beta for local-first AI pull-request review, so strong
contributions are focused, test-backed, and careful about public claims.

## Quick Links

- [Setup guide](docs/SETUP.md)
- [Repository agent instructions](AGENTS.md)
- [Operator CLI](docs/operator-cli.md)
- [GitHub App setup](docs/github-app-setup.md)
- [Security policy](SECURITY.md)
- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Product roadmap](https://github.com/electricsheephq/neondiff/issues/103)
- [Public beta release readiness](https://github.com/electricsheephq/neondiff/issues/232)

## Issue Routing

Use the GitHub issue forms and keep one problem per issue.

| Situation | Use | Required evidence |
| --- | --- | --- |
| Product bug, bad review, crash, or wrong output | Bug report | Version/SHA, command, repo/PR shape, expected result, actual result, redacted logs |
| Missing, stale, or contradictory docs | Docs bug report | Affected path, current wording, expected wording, setup impact |
| New capability or product improvement | Feature request | User story, proposed behavior, alternatives, safety boundary |
| Provider, model, or runtime adapter | Provider request | Provider/runtime, auth shape, data sent, failure modes, proof available |
| License, public/private repo, or setup confusion | License/setup confusion | Question, current doc path, expected answer, no secrets |
| Unsafe review behavior | Unsafe review report | Repo/PR/head SHA, whether dry-run happened, posted/suppressed behavior, redacted evidence |

Security vulnerabilities should be reported privately through
[SECURITY.md](SECURITY.md), not as public issues.

## Before You Open A PR

1. Create or reuse a GitHub issue and include `Closes #<issue>` or
   `Related: #<issue>` in the PR.
2. Read [docs/SETUP.md](docs/SETUP.md) before changing install, auth, provider,
   daemon, or first-run behavior.
3. Write or update a failing test, smoke, or eval scenario before implementing
   non-trivial behavior.
4. Keep the PR focused on one user-visible or maintainer-visible problem.
5. Keep product claims inside the documented source-available beta boundary.

Good First Contributions:

- docs setup gaps and clearer troubleshooting
- redacted fixture improvements
- CLI help wording
- issue template improvements
- tests for secret redaction, stale-head behavior, setup status, and docs claims
- small repo-profile or policy examples that do not expand live monitoring

Avoid refactor-only PRs unless a maintainer linked the refactor to an active
issue.

## Development

```bash
npm install
npm run build
npm test
```

For fast iteration, run the focused test file that owns your change before the
full suite. Prefer GitHub CI for heavyweight validation.

Do not commit GitHub App private keys, provider API keys, license keys, tokens,
cookies, raw customer data, raw private logs, raw SQLite DBs, screenshots with
private data, connector URLs, or local launchd secrets.

## Validation And Evidence

Every meaningful PR should name the proof it ran:

- failing test, smoke, or eval scenario used to define the change
- focused validation command
- `npm test` and `npm run build`, or why CI is the right place for heavier validation
- dry-run review evidence when the change affects review behavior
- evidence path such as `/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence/YYYY-MM-DD/issue-<number>/`

Evidence should contain public-safe summaries, counts, refs, hashes, setup
status, blocker codes, and command names. It must not contain secrets, raw PR
diffs from private repos, raw customer logs, credentials, or private keys.

## Agent-Authored Contributions

Agent-authored PRs are welcome when the agent leaves a human-reviewable trail.
If a coding agent authored or materially edited the PR:

- say so in the PR body
- keep the issue updated before handoff, merge, or pause
- include the exact focused validation commands
- summarize safety boundaries and restricted actions not performed
- resolve or reply to bot review conversations after addressing them
- do not claim live worker promotion, public launch, CodeRabbit parity, or
  customer readiness unless the matching proof gates pass

Agents should read [AGENTS.md](AGENTS.md) before editing this repository.

## Pull Request Expectations

- Preserve source-available beta wording unless #104 is updated with approved license text.
- Preserve public open-source repos free and private/commercial repos paid.
- Preserve dry-run before live posting.
- Preserve current-head duplicate suppression and stale-head checks.
- Preserve secret-looking finding suppression.
- Add or update tests for review behavior, setup status, docs claims, release
  gates, or scorecards when those surfaces change.
- Do not add auto-merge, branch repair, approval reviews, hidden GitHub writes,
  hosted model resale, or broader repo monitoring without a separate issue and
  proof boundary.

## Review Threads

Review conversations are author-owned. If a bot or human leaves an actionable
thread:

- verify it against current code before changing anything
- fix real issues with focused tests
- explain false positives with concrete file/test evidence
- reply with the terminal outcome
- resolve the thread when the concern is handled

Do not leave "fixed" bot threads for maintainers to clean up.

## Safety Boundaries

NeonDiff is local-first and source-available. Public contributions must not
widen these claims without explicit evidence:

- no open-source/MIT claim
- no public launch claim while the repo remains private
- no final legal/license adequacy until #104 closes
- no enterprise/customer-ready security claim
- no calibrated review-accuracy claim before labeled evals prove it
- no live worker restart or launchd promotion from a docs PR
- no GitHub App permission expansion without a tracked rollout

When in doubt, file a design issue first.
