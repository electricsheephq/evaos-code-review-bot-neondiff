# Teams And GitHub Marketplace Plan

Issue: [#124](https://github.com/electricsheephq/evaos-code-review-bot/issues/124)
Milestone: v1.4 Teams, Marketplace, and Enterprise
Status: planning only; not shipped

This plan defines the commercial and team administration layer that can follow a
safe individual public MVP. It does not change the current source-available beta
boundary, publish a Marketplace listing, enable hosted review, or make enterprise
readiness claims.

## Goals

- Give team admins org-wide policy templates, centralized provider settings, and
  audit logs before enabling NeonDiff across many private repositories.
- Define how license seats and GitHub App installations map to private repo
  review without treating provider/model spend as bundled SaaS inference.
- Choose between GitHub Marketplace and direct billing before implementation
  creates customer-facing checkout, entitlement, or listing claims.
- Separate MVP, Pro, Team, and Enterprise capabilities so public docs and
  engineering work do not blur beta support tiers into shipped enterprise
  features.
- Specify update rings, privacy language, retention defaults, validation
  evidence, and engineering work packets for the team/commercial roadmap.

## Non-Goals

- Do not block the v1.0 public MVP or individual source-checkout beta on this
  plan.
- Do not implement license enforcement, hosted services, seat sync, billing
  webhooks, Marketplace listing pages, or admin UI in this issue.
- Do not claim Marketplace availability, enterprise security readiness, SSO,
  SOC 2, data residency, or hosted model credits until separate implementation
  and proof gates close.
- Do not expand GitHub App permissions just because an org installs a Team or
  Enterprise plan. Permission expansion remains explicit, reviewed, and tied to
  a shipped feature.

## Plan Boundaries

| Boundary | MVP | Pro | Team | Enterprise |
| --- | --- | --- | --- | --- |
| Intended buyer | Individual maintainer or OSS project | Private repo user or small commercial team | Org admin with multiple repos | Enterprise admin with compliance and support controls |
| GitHub App install | Selected repos only | Selected private or commercial repos | Org install with repo allowlist required | Org install with allowlist, update ring, and support policy |
| Billing | Free public open-source use | Direct license key or later Marketplace license | Seat or installation license; channel TBD | Contract or private offer; channel TBD |
| Provider settings | Local config per worker | Local config per worker | Central provider profile references, no stored provider secrets | Central provider policy plus approved provider catalog |
| Policy | Local repo policy | Local repo policy plus private repo entitlement | Org policy templates with per-repo overrides | Locked templates, exception workflow, and audit export |
| Audit logs | Local evidence only | Local evidence only | Admin-readable org audit events | Retention policy, export, and support packet controls |
| Update ring | Manual source/beta updates | Beta/stable channel after public package exists | Org default ring with repo or worker override | Ring pinning, delayed rollout, and emergency hold |
| Support boundary | Community/beta docs | Paid support for private/commercial use | Admin support for install/license/policy | Contracted support, escalation, and security review |

MVP remains the current local-first source-available beta posture. Pro starts
with paid private/commercial repo support. Team adds org administration and
installation/seat management. Enterprise adds controlled rollout, compliance
evidence, and contractual support; it is not just a larger Team plan.

## Org Policy Templates

Team and Enterprise plans need named policy templates that admins can apply to
multiple repositories without hand-editing each repo profile.

Required template fields:

- `templateId`: stable identifier such as `team/default-private-review`.
- `scope`: org, repo, or repo group.
- `reviewMode`: dry-run only, comment only, or request-changes eligible.
- `severityThreshold`: minimum severity for inline comments and status summary.
- `draftPrPolicy`: skip, dry-run, or review.
- `secretFindingPolicy`: suppress, evidence-only, or admin-alert-only.
- `repoAllowlist`: exact repo names or repo group ids.
- `providerProfileId`: reference to a centralized provider profile.
- `updateRing`: beta, stable, enterprise-stable, or pinned.
- `auditLevel`: minimal, standard, or compliance.
- `exceptionOwner`: admin or group responsible for policy overrides.

Override rules:

- Repo-local policy may make review stricter than the org template.
- Repo-local policy may make review looser only when the template allows
  override and records an audit event.
- A missing Team/Enterprise entitlement fails closed before provider calls,
  worktree prep, or GitHub review posting for private repos.
- Policy templates must never contain provider API keys, GitHub private keys,
  license keys, personal tokens, or raw customer data.

## Centralized Provider Settings

Central provider settings should reduce setup drift while preserving the
local-first and customer-owned provider model.

Provider profiles store:

- provider id and display name
- endpoint base URL or local runtime type
- model id
- timeout and retry policy
- concurrency limit
- cost-center tag
- environment variable name or secret reference name for the API key
- allowed repo scopes
- health-check command and last successful check timestamp

Provider profiles must not store the provider API key itself. Admin UX and CLI
commands should show whether a required key reference is configured, not the key
value. Provider/model costs remain external unless a later hosted plan explicitly
ships bundled inference with separate pricing and privacy review.

## License Seats And Installations

The license model needs to account for both humans and GitHub App installations.

Definitions:

- Seat: a licensed human or service-admin identity allowed to administer private
  or commercial NeonDiff use.
- Installation: a GitHub App installation on an org or account.
- Covered repo: a private or commercial repo permitted by entitlement, policy,
  and GitHub App installation scope.
- Worker: a local or managed process that performs review for covered repos.

Initial entitlement checks:

- Pro: one buyer account, limited private/commercial repos, local worker.
- Team: org installation plus seat count and covered repo count.
- Enterprise: org or enterprise account, private offer/contract terms, update
  ring controls, and audit export.

Seat enforcement should start advisory until the license API, install sync, and
admin views have reliable evidence. Private repo review still fails closed when
there is no active entitlement for private/commercial use.

## Audit Logs

Team admins need audit logs that explain what happened without exposing secrets
or raw review payloads by default.

Required events:

- GitHub App installation created, updated, suspended, or removed.
- Repo added to or removed from a covered allowlist.
- Policy template created, changed, applied, overridden, or removed.
- Provider profile created, changed, enabled, disabled, or failed health check.
- License activated, renewed, expired, seat limit exceeded, or installation
  count exceeded.
- Review attempted, skipped, posted, suppressed, rate-limited, or failed closed.
- Update ring changed, pinned, advanced, held, or emergency-rolled back.
- Audit export created or retention policy changed.

Event fields:

- event id
- event type
- organization and repo when applicable
- actor type and actor id, using GitHub/user ids rather than email where
  possible
- timestamp
- affected policy, provider profile, license, installation, or update ring id
- public-safe reason code
- evidence path or external event id
- redaction version

Audit logs should default to standard retention for Team plans and configurable
retention for Enterprise. Logs must not include provider API keys, GitHub private
keys, license keys, raw prompts, raw model responses, unredacted diffs, or raw
customer secrets.

## Update Rings

Update rings keep public beta, team adoption, and enterprise-controlled rollout
separate.

| Ring | Audience | Advance rule | Hold rule |
| --- | --- | --- | --- |
| `beta` | Maintainers and early Pro users | Manual prerelease adoption after release notes and focused validation | Any release blocker, regression, or unresolved high-risk review finding |
| `stable` | Pro and default Team installs | Promote from beta after CI, smoke evidence, and no known critical regressions | Failed upgrade smoke, support incident, or license/API regression |
| `enterprise-stable` | Enterprise installs | Promote from stable after delayed soak and admin notice | Customer hold, security review, contract gate, or compliance concern |
| `pinned` | Enterprise exception | Explicit admin pin to exact version | Emergency advisory only; admin must unpin or approve |

Workers should report their ring, current version, available version, release
notes URL, and whether a hold/pin is active. Update checks must not mutate local
installations without explicit admin policy and proof that the package channel is
real.

## Marketplace Vs Direct Billing

The implementation must choose the customer-facing billing channel before
building checkout, entitlements, or public listing copy.

| Decision factor | GitHub Marketplace | Direct billing / license portal |
| --- | --- | --- |
| Buyer fit | Best for GitHub-native buyers who expect App install and purchase in one flow | Best for early customers, enterprise private offers, and nonstandard contracts |
| License sync | Can align paid plan with GitHub account/org installation if Marketplace APIs fit the App flow | Needs custom entitlement service and installation mapping |
| Seat/install model | Must fit GitHub Marketplace plan constraints and customer billing expectations | Flexible seats, covered repos, private offers, and contract terms |
| Time to validate | Slower if listing review, plan setup, and webhook handling are blockers | Faster for controlled beta and private/commercial license keys |
| Customer trust | Strong GitHub-native purchase surface | Requires clear vendor billing, receipts, and cancellation flow |
| Enterprise sales | Possible through Marketplace private offers if supported | Stronger for custom terms, procurement, and support commitments |
| Operational burden | Marketplace webhooks, listing review, GitHub plan states, refund/cancel handling | Billing portal, tax/receipts, subscription lifecycle, dunning, license API |
| Public claim risk | High if docs imply listing exists before approval | Lower if docs keep direct beta license language precise |

Recommended sequence:

1. Keep direct license activation as the first private/commercial beta path.
2. Design the entitlement model so Marketplace and direct billing can both map
   to the same internal license contract.
3. Build Marketplace only after the GitHub App install flow, plan boundaries,
   webhook handling, privacy copy, and support commitments are reviewed.
4. Do not publish website or README Marketplace availability claims until the
   listing is approved and the install-to-entitlement path is proven end to end.

Open product decision: whether Team should launch as direct billing first,
Marketplace first, or dual-channel. The safest default is direct billing first
with a Marketplace-compatible entitlement schema.

## Privacy And Data Retention Language

Public and admin-facing language should say:

- NeonDiff is local-first by default. The worker reads GitHub pull-request data
  needed for the configured review and stores local evidence for operator
  accountability.
- Provider/model calls use the provider profile selected by the customer or
  local operator. Provider data handling depends on that provider and is not
  bundled into NeonDiff unless a future hosted inference plan explicitly ships.
- License and team services may store account id, org id, installation id,
  covered repo metadata, plan, entitlement status, seat counts, update ring,
  billing channel, and audit events.
- Team audit logs should store reason codes, event metadata, and redacted
  evidence references by default, not raw diffs, raw prompts, raw model outputs,
  provider API keys, GitHub private keys, license keys, or personal access
  tokens.
- Default Team retention should be short and explicit, such as 90 days for
  hosted license/audit metadata unless a customer chooses a different supported
  option. Enterprise retention should be configurable by contract and documented
  in the admin policy.
- Deletion and export paths must distinguish local worker evidence from hosted
  license/audit metadata. Deleting hosted account metadata cannot promise to
  delete customer-owned local logs that live outside NeonDiff control.

Final privacy copy needs legal review before it is reused on the website,
Marketplace listing, security docs, or checkout flow.

## Validation And Evidence

Before implementation starts:

- Confirm GitHub App permissions still match the planned install and audit
  events.
- Confirm whether Marketplace APIs and listing constraints can represent Pro,
  Team, and Enterprise boundaries without misleading plan names.
- Confirm license API schema can represent direct billing and Marketplace
  entitlements through the same internal contract.
- Confirm public docs contain no Marketplace availability claim until the listing
  path is real.
- Confirm audit and provider settings store references and redacted metadata,
  not secrets.

Before launch:

- Run license entitlement tests for public, Pro, Team, expired, over-seat,
  over-installation, canceled, and API-outage states.
- Run GitHub App installation sync tests for selected repos, all repos, removed
  repos, suspended install, and org rename.
- Run policy template tests for strict override, loose override denied, repo
  allowlist miss, provider profile miss, and fail-closed private repo review.
- Run audit redaction tests against provider keys, GitHub private keys, license
  keys, tokens, raw prompts, raw model responses, and diff snippets that look
  secret-like.
- Run update-ring tests for beta to stable promotion, enterprise delayed
  promotion, pinned install, emergency hold, and rollback notice.

Evidence packets should include command output summaries, public-safe fixtures,
GitHub issue or PR links, release tags when applicable, and docs links. They
must not include secrets, raw customer data, or private logs.

## Engineering Breakdown

1. Entitlement contract
   - Define a shared internal entitlement object for direct billing and
     Marketplace.
   - Add plan, buyer account, org id, installation id, seat count, covered repo
     count, update ring, billing channel, expiry, and grace-state fields.
   - Add fixtures for MVP, Pro, Team, Enterprise, expired, canceled, over-seat,
     and API-outage states.

2. GitHub installation sync
   - Read installation account, selected repositories, suspension state, and
     permission grants.
   - Map installations to covered repos without broadening review scope.
   - Record install/update/remove events in redacted audit form.

3. Org policy templates
   - Add schema and validation for policy templates.
   - Add merge rules for org template plus repo override.
   - Fail closed when private repo review lacks entitlement, policy, provider
     profile, or current-head proof.

4. Central provider profiles
   - Add provider profile schema with secret-reference-only key handling.
   - Add health-check status and admin-readable readiness output.
   - Prevent raw provider secrets from entering tracked config, audit logs, or
     evidence packets.

5. License seats and installations
   - Implement advisory seat/install reporting first.
   - Gate private/commercial repo review on entitlement before provider calls.
   - Add over-seat and over-installation reason codes before hard enforcement.

6. Audit log pipeline
   - Define event schema, redaction version, retention setting, and export path.
   - Add tests for required event coverage and secret redaction.
   - Keep raw prompts, raw model outputs, and raw diffs out of hosted audit logs
     by default.

7. Update rings
   - Add ring metadata to license/admin status output.
   - Implement ring promotion, hold, and pin states before auto-update behavior.
   - Keep package/update publication in a separate release lane.

8. Billing channel implementation
   - Keep direct license activation working as the beta path.
   - Build Marketplace webhook ingestion only after the Marketplace decision
     record is accepted.
   - Normalize direct and Marketplace events into the same entitlement object.

9. Admin docs and public copy
   - Add admin setup docs after schemas and commands exist.
   - Add Marketplace copy only after approval and end-to-end proof.
   - Keep README wording as source-available beta until the tracked license and
     distribution issues close.

## Remaining Product Decisions

- Whether Team launches direct-billing first, Marketplace first, or dual-channel.
- Exact Team seat metric: human admin seats, covered repos, active workers, or a
  hybrid.
- Whether Enterprise private offers run through GitHub Marketplace private
  offers, direct contracts, or both.
- Default hosted audit retention length for Team, and whether customers can
  shorten it.
- Whether update-ring control is included in Team or reserved for Enterprise.
- Whether centralized provider profiles are CLI-only for v1.4 or require an
  admin UI before launch.
- Whether hosted license/audit metadata is operated by Electric Sheep directly
  or through a separate vendor/service boundary.
