# Known Limitations And Provider Status

Pinned discussion title: `Known limitations and provider status before GA`

This page is intentionally blunt. It is safe to link from a launch issue,
discussion, or PR, but it is not proof that launch is complete. The owner can
copy this content into a GitHub Discussion and pin it; this PR only adds the
repo-owned source document and does not pin GitHub UI state.

## Status Terms

| Term | Meaning |
| --- | --- |
| `tested by NeonDiff` | Repo evidence has covered this path with fixture, doctor, smoke, dry-run, or live-route proof. It is not a quality-parity claim. |
| `compatible by interface` | The API shape can be described or checked, but live review promotion still needs NeonDiff proof. |
| `planned` | Tracked work exists, but users should not rely on it as shipped. |
| `resource only` | Useful for discovery, not compatibility proof. |
| `not claimed` | Do not market or depend on this behavior until a specific issue and PR prove it. |

## Provider Status

| Provider or runtime | Current status | macOS status | Linux status | Egress posture | What is still missing |
| --- | --- | --- | --- | --- | --- |
| GLM/Z.AI through ZCode (`zcode-glm`) | `tested by NeonDiff` as the default beta route | Used by the current local beta operator path | Expected only where the local ZCode/provider setup is available; not a broad Linux launch claim | Hosted provider receives prompts and diff context | Does not prove CodeRabbit parity, calibrated accuracy, or every repo shape |
| Ollama on `http://localhost:11434/v1` | `compatible by interface` | Provider doctor/smoke path only until adapter proof promotes live review | Provider doctor/smoke path only until adapter proof promotes live review | No-egress only when the endpoint and model are local | Live review promotion, quality evidence, redaction proof, duplicate-suppression proof |
| LM Studio, vLLM, or local OpenAI-compatible gateway | `compatible by interface` | Describable as local/self-hosted OpenAI-compatible endpoints | Describable as local/self-hosted OpenAI-compatible endpoints | No-egress only for local/self-hosted endpoints | Fixture and dry-run review proof before live usage |
| Hosted OpenAI-compatible BYOK gateway | `compatible by interface` | Remote smoke requires explicit opt-in | Remote smoke requires explicit opt-in | Hosted provider receives prompts and diffs | Remote smoke, live review proof, and provider-specific privacy/terms review |
| Free/trial provider catalogs | `resource only` | Discovery only | Discovery only | Usually hosted; each provider differs | Provider-specific issue, auth boundary, terms review, and NeonDiff proof |
| Agent runtimes such as Codex CLI, Claude Code, or OpenCode | `planned` / discovery-stage | Not a live provider adapter | Not a live provider adapter | Depends on each runtime and its provider chain | Bounded no-write runtime contract, output schema, timeout handling, current-head behavior |

See [docs/providers.md](providers.md) for setup examples and the longer
provider registry.

## Backend And Platform Limitations

| Surface | Current launch-readiness truth |
| --- | --- |
| CLI/source checkout | Node.js 26 and npm are required. Source checkout remains the contributor fallback. This document does not prove every Linux distribution or shell environment. |
| npm package | Use the version named in README/setup docs. Dist-tag and package truth must be checked before public announcements. |
| GitHub App review posting | Live posting is gated by configured repos, current-head checks, duplicate suppression, provider readiness, and dry-run evidence. NeonDiff does not approve PRs, merge, push repairs, or silently expand permissions. |
| Daemon supervision | The live beta operator path is macOS launchd-oriented. Linux systemd, Docker, and CI-runner assets are packaged and guarded by an Ubuntu smoke workflow, but provider-specific Linux review quality and every distribution shape are not claimed. |
| Desktop app | macOS dev MVP only. No signed/notarized/appcast/TCC/customer-control readiness is claimed. |
| License activation | Public repos are free. Private/commercial repos require a paid support license. The beta file backend is the active CLI path; Keychain activation is intentionally not a headless write path. |
| Security | Security policy exists, but this is not an enterprise/customer-ready security certification. Use private GitHub vulnerability reporting for secrets or private data. |
| Support alias | `support@electricsheephq.com` is listed as a launch support contact that requires owner verification before public launch. This repo has no evidence that the alias is monitored. |

## What Visitors Should Self-Triage Before Filing

1. Check whether the issue is provider-specific, backend-specific, platform-specific, or docs/setup-only.
2. Use the bug template when behavior is wrong, and fill the provider/backend matrix.
3. Use the provider request template for a new model/runtime/provider path.
4. Use the question template when the right route or proof boundary is unclear.
5. Use private security reporting, not a public issue, for secrets, credentials, private diffs, private repo data, or customer data.

## Not Claimed Before GA

- Public launch completion.
- Final legal/license adequacy.
- CodeRabbit parity.
- Calibrated review accuracy.
- Enterprise or customer-ready security.
- Broad Linux distribution coverage beyond the packaged systemd/Docker/Ubuntu-smoke path.
- Signed/notarized desktop release.
- Universal provider compatibility.
- Hosted review SaaS with bundled model credits.
