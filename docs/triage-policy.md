# NeonDiff Triage Policy

This policy is a public intake contract for a single-maintainer,
agent-assisted repository. It describes intent, not a guaranteed service-level
agreement. Security reports, customer data, credentials, private diffs, and
license keys do not belong in public issues.

## Intake Routes

| Route | Use it for | Do not use it for |
| --- | --- | --- |
| Bug report | Product bugs, crashes, wrong review output, setup failures, provider/backend regressions | Secrets, private repo diffs, customer data |
| Provider request | New providers, local runtimes, hosted BYOK gateways, adapter/runtime work | Claiming a provider is tested without NeonDiff proof |
| Question | Public-safe setup, provider, license, roadmap, or workflow questions | Vulnerabilities or private account data |
| Docs bug report | Missing, stale, contradictory, or unsafe docs | Product behavior bugs |
| License/setup confusion | Public/private repo boundary, install, update entitlement, or pricing confusion | Billing account data or license keys |
| Unsafe review report | Public-safe unsafe review behavior, stale-head behavior, posting, or redaction gaps | Raw private diffs, credentials, or secrets |
| Private security report | Vulnerabilities, secrets, credentials, private repo content, customer data | General product questions |

Private security route: [SECURITY.md](../SECURITY.md).

Non-security support alias: `support@electricsheephq.com`. This alias is listed
for launch readiness but requires owner verification before public launch; this
repo currently has no explicit evidence that it is monitored.

## Label Policy

Use existing labels before creating new ones.

| Label family | Intended use |
| --- | --- |
| `bug` | Reproducible wrong behavior, crashes, bad output, broken setup |
| `docs` / `documentation` | Documentation updates, examples, schemas, docs-site surfaces |
| `question` | Public-safe questions that do not yet require product work |
| `enhancement` | New capabilities or product improvements |
| `provider-registry` | Provider/model/runtime metadata, adapter, smoke, BYOK, or provider-proof work |
| `review-policy` | Review behavior, filters, severity routing, posting policy |
| `repo-profile` | Repository-specific review profile, path policy, or proof expectations |
| `license` / `pricing` | Entitlement, activation, support-tier, package, or commercial-boundary work |
| `release-governance` | Release cadence, update channels, rollback, signing, public beta gates |
| `public-product` / `website` | Public productization, website, buyer-facing docs |
| `ga-blocker` / `v1-mvp` | Work that blocks or belongs to the public v1.0 MVP |
| `owner-gated` | Requires owner credential, account action, install, approval, or external verification |
| `decision-needed` | Human product, licensing, pricing, or architecture decision needed |
| `sprint:active`, `sprint:next`, `sprint:blocked` | Current sprint routing and explicit blockers |
| `post-1.0` / `deferred-spike` | Intentionally deferred work or exploration outside the current release scope |

If a report involves credentials, private diffs, private repo names, customer
data, or a vulnerability, do not label it publicly. Move it to the private
security route first.

## Response-Time Intent

These are triage goals for launch-influx handling, not promises.

| Class | Intent |
| --- | --- |
| Private security report | Acknowledge as soon as owner availability permits; keep discussion private. |
| `ga-blocker`, release regression, data-loss, posting safety, or credential exposure | Same or next maintainer cycle when evidence is public-safe. |
| Reproducible `bug` with provider/backend matrix and evidence | First triage within a few maintainer cycles. |
| Provider request with public API docs and proof notes | Batch review during provider-registry planning. |
| Docs bug, question, setup confusion | Batch review when launch support bandwidth permits. |
| Resource-only catalog suggestions | Defer unless a provider-specific proof issue exists. |

## Agent-Driven Triage Behavior

NeonDiff's own bot reviews PRs. Agent-authored triage and PR work is allowed
when it stays inside the repo's proof boundary:

- Agents may suggest labels, routes, missing evidence, and safer issue forms.
- Agents may open PRs linked to issues when scoped by a maintainer or an issue.
- Agents must not auto-close issues, merge PRs, tag releases, publish packages,
  restart live workers, mutate live config, expand permissions, or claim public
  launch readiness without the matching proof gates.
- Agents must keep public comments free of secrets, raw private diffs,
  customer data, license keys, provider tokens, cookies, and connector URLs.
- Agents should distinguish `tested by NeonDiff`, `compatible by interface`,
  `planned`, and `resource only` provider states.
- Agents should update the issue before handoff or pause when they changed
  code, docs, labels, roadmap state, or operating evidence.

## Escalation And Security Routing

Escalate privately when a report includes any of:

- GitHub App private key, token, cookie, or connector URL.
- Provider API key, license key, or billing/account data.
- Raw private PR diff, private repo name, customer logs, or customer identity.
- Vulnerability that could expose private code, credentials, comments, or local
  evidence.
- Reported behavior that posted secrets or private data publicly.

Use GitHub private vulnerability reporting first. Use
`support@electricsheephq.com` only for non-security support until the owner
verifies alias monitoring.
