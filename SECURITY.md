# Security Policy

NeonDiff is local-first review infrastructure. It handles GitHub App
credentials, provider configuration, PR metadata, diffs, local evidence, and
review comments, so security reports should be handled privately.

## Supported Surface

This repository is a source-available beta. Security review applies to the
current `main` branch and active prerelease/live-beta branches linked from
GitHub issues.

## Reporting A Vulnerability

Do not open a public issue for vulnerabilities, secrets, credential exposure,
private PR content, or customer data.

Report privately to the maintainers with:

- affected commit, tag, or branch
- affected command or runtime surface
- minimal reproduction steps
- whether live posting, GitHub App auth, provider auth, license handling, or
  local evidence is involved
- redacted logs only

Never include private keys, provider tokens, license keys, raw private diffs,
customer logs, cookies, or connector URLs in a public issue or PR.

## Public Issue Boundary

Use public issues for docs bugs, setup confusion, provider requests, feature
requests, and public-safe unsafe-review reports. If a report contains secrets
or private repo data, move it to the private security channel first.

## Safety Defaults

Security-sensitive contributions must preserve these defaults:

- dry-run before live review posting
- current-head duplicate suppression
- stale-head checks before posting
- secret-looking finding suppression
- configured repo allowlists
- no approval reviews by default
- no branch repair, auto-merge, or hidden GitHub mutation
- no GitHub App permission expansion without a tracked issue and proof gate
