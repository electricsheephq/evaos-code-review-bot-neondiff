# Agent Runtime Adapters

Issue #243 is discovery and contract work only. It does not add live runtime
support, does not change provider selection, and does not claim that Codex CLI,
Claude Code, or OpenCode can run NeonDiff reviews today.

NeonDiff's current provider registry describes model/provider transports such
as ZCode-backed GLM/Z.ai and OpenAI-compatible APIs. Agent runtimes are a
different integration class: they are coding agents that may read a checkout,
call tools, use their own model/provider settings, and produce output after an
agent loop. NeonDiff must not collapse those runtimes into ordinary provider
adapters unless a later implementation proves a bounded contract.

## Classification

| Candidate | Classification | Dated observation | Current NeonDiff claim |
| --- | --- | --- | --- |
| Codex CLI | Agent-runtime adapter candidate; possible invocation plugin | Observed on 2026-07-05 as a local coding agent CLI with non-interactive/scriptable execution and JSONL event output. Its model access and approval/sandbox settings are owned by Codex, not by NeonDiff's provider registry. | No live support. Do not list as a NeonDiff provider. |
| Claude Code | Agent-runtime adapter candidate; possible invocation plugin or SDK bridge | Observed on 2026-07-05 as an agentic coding CLI with print mode, structured output options, permission modes, tools, plugins, and its own Anthropic/account/provider configuration. | No live support. Do not list as a NeonDiff provider. |
| OpenCode | Agent-runtime adapter candidate; possible invocation plugin | Observed on 2026-07-05 as an AI coding agent with CLI commands, agents, permission configuration, and internal model/provider selection. Even when OpenCode is configured for GLM, Z.AI, or another provider, NeonDiff would be invoking OpenCode, not directly calling that provider. | No live support. Do not list as a NeonDiff provider. |

Related orchestration layers such as Looper are not provider adapters either.
They can schedule or supervise agent CLIs, but they are not model gateways and
do not prove NeonDiff runtime compatibility.

## Taxonomy

- **Model provider adapter:** NeonDiff owns the transport to a model API or
  local model endpoint, shapes the prompt, parses the model response, and
  normalizes provider failures.
- **Agent-runtime adapter:** NeonDiff launches a bounded coding-agent runtime
  with a review packet and receives a structured review result. The runtime may
  have its own model provider, tool loop, permissions, memory, plugins, and
  local state.
- **Invocation plugin:** A thin external-command wrapper for a user-managed
  agent runtime. It is useful only if it obeys the adapter contract below and
  is tested as an extension point, not as an ordinary provider.
- **Orchestration layer:** A scheduler, daemon, or PR/issue loop that may call
  agents. It belongs above NeonDiff execution and does not replace provider or
  runtime adapter proof.

## Proposed Contract

The adapter contract should be explicit before any implementation issue starts.
The first implementation should be opt-in, disabled by default, and limited to
dry-run fixture review until redaction, no-write, schema, timeout, and evidence
proof exist.

### Inputs

An agent-runtime adapter receives a single review request envelope:

- repo owner/name, PR number, base SHA, head SHA, and current-head proof
- sanitized diff packet limited to files and hunks selected by NeonDiff
- repo policy, severity thresholds, posting policy, and stale-head constraints
- system instructions that require review-only behavior and forbid file writes
- expected JSON output schema and maximum finding count
- working directory, checkout path, and optional read-only evidence directory
- timeout, stdout/stderr byte limits, and maximum tool/turn budget
- runtime id, binary path, version requirement, and command template
- explicit environment allowlist, never raw inherited secrets

The request should not include GitHub App private keys, write tokens, license
keys, customer data, raw private logs, cookies, or broad process environment
state.

### Outputs

The runtime must return structured JSON that NeonDiff can validate before any
posting path sees it:

- runtime metadata: runtime id, binary version, adapter version, exit code,
  duration, cwd, and command fingerprint
- review metadata: repo, PR, base SHA, head SHA, prompt/diff hashes, and
  current-head assertion used by the request
- findings: file path, RIGHT-side line, severity, confidence, title, message,
  evidence summary, and optional rule/source id
- summary: concise review summary without hidden chain-of-thought or raw prompt
  echo
- evidence: redacted stdout/stderr hashes, bounded redacted previews, and local
  evidence paths
- unsupported capabilities or refusal reason when the runtime cannot honor the
  contract

If the output is missing required fields, contains prose instead of JSON,
references non-current diff lines, asks NeonDiff to apply edits, or includes
secret-looking values, the adapter should fail closed before live posting.

### Execution Boundaries

- Run only from a NeonDiff-selected checkout or temp worktree for the exact PR
  head under review.
- Prefer a read-only filesystem mount or sandbox. Where the runtime cannot
  guarantee read-only behavior, detect any file modification and classify it as
  `unsafe_write_attempt`.
- Do not grant GitHub write tokens, package publish tokens, private keys, broad
  cloud credentials, customer credentials, or live config mutation access.
- Do not allow branch repair, commit creation, dependency installation, daemon
  restarts, launchd changes, release promotion, or GitHub comments from the
  agent runtime.
- Do not rely on the runtime's memory, plugins, MCP servers, browser tools, or
  background agents unless a later issue explicitly proves those surfaces.
- Use a dedicated HOME/config/cache location when possible so runtime state is
  observable and does not leak unrelated local sessions.

### Security And No-Write Expectations

The default contract is review-only. The runtime may read the selected checkout
and generate findings, but it must not mutate files, git state, GitHub state,
local config, credentials, or release/runtime surfaces.

Future adapters should fail closed on:

- modified tracked, untracked, or ignored files after invocation
- attempts to run configured denylisted commands
- stdout/stderr containing secret-looking values after redaction
- requests for approval to write, install, authenticate, restart, or post
- output that instructs NeonDiff to trust a non-current head or unbounded diff

### Evidence And Redaction

Evidence should be useful to operators without exposing private data:

- record command name, runtime id, binary version, exit status, duration, and
  resource limits
- hash prompt and diff packets instead of writing raw private prompts/diffs into
  public evidence
- store only redacted, size-bounded stdout/stderr previews
- redact tokens, private keys, cookies, bearer headers, API keys, license keys,
  customer identifiers where configured, and secret-looking strings
- keep raw runtime transcripts out of GitHub comments and release notes
- mark evidence as dry-run fixture proof, local smoke proof, or live-review
  proof; do not let one proof class imply another

### Timeout And Error Classes

Normalize runtime failures before they reach provider-level reporting:

| Class | Meaning |
| --- | --- |
| `binary_missing` | Runtime executable was not found or did not satisfy the version requirement. |
| `auth_unavailable` | Runtime requires login, account state, or provider credentials that are not available to the adapter. |
| `permission_denied` | Runtime or sandbox refused required read-only access. |
| `unsupported_capability` | Runtime cannot accept the requested schema, non-interactive mode, sandbox, timeout, or no-write boundary. |
| `unsafe_write_attempt` | Files, git state, config, or external state changed during invocation. |
| `timeout` | Runtime exceeded the configured wall-clock limit. |
| `nonzero_exit` | Runtime exited unsuccessfully without a narrower normalized class. |
| `schema_invalid` | Output was missing, malformed, unstructured, or failed NeonDiff review-result validation. |
| `output_limit` | stdout, stderr, or JSON output exceeded configured evidence limits. |
| `provider_or_rate_limit` | Runtime surfaced provider quota, throttle, or upstream model availability errors. |
| `runtime_refusal` | Runtime explicitly refused the task or requested unsupported permissions. |
| `unknown` | Failure could not be classified safely. |

Provider-runtime failures may later map into existing NeonDiff categories such
as `auth`, `throttle`, `network`, `timeout`, `model-output`, and `unknown`, but
the agent-runtime layer needs these narrower classes so a missing CLI or unsafe
write attempt is not mistaken for a model-provider outage.

## Unsupported Claims

This discovery document does not claim:

- Codex CLI, Claude Code, or OpenCode live review support
- Codex CLI, Claude Code, or OpenCode as NeonDiff provider registry entries
- Looper or another orchestration layer as a model gateway
- no-egress behavior unless the agent runtime, its configured model provider,
  and its tool/plugin state are all proven local-only
- CodeRabbit parity, calibrated review accuracy, auto-fix support, branch
  repair, or merge readiness
- safe use of runtime memory, plugins, MCP servers, browser tools, background
  agents, or shared user HOME state

## Reference Surfaces

These references informed the classification above on 2026-07-05:

They are point-in-time reference surfaces, not durable support claims. The
classification should continue to stand on the documented runtime properties
and proof gates even if a vendor moves or rewrites one URL.

- [OpenAI Codex CLI overview](https://developers.openai.com/codex/cli)
- [OpenAI Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Claude Code quickstart](https://code.claude.com/docs/en/quickstart)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [OpenCode intro](https://opencode.ai/docs/)
- [OpenCode CLI reference](https://opencode.ai/docs/cli/)
- [Z.AI OpenCode integration guide](https://docs.z.ai/devpack/tool/opencode)

## Follow-Up Gates

Before any agent-runtime implementation PR claims readiness, it should add:

Tracking starts in discovery issue
[#243](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/243)
and should be split into a dedicated implementation issue before any runtime
adapter code ships.

- mocked adapter contract tests for input shaping, command construction, and
  output parsing
- fixture review proof for schema-valid findings and current-head line mapping
- redaction tests for stdout, stderr, prompt hashes, and raw evidence previews
- no-write smoke proof that fails on tracked, untracked, or ignored file changes
- timeout and normalized error-class tests
- docs and public-claims checks that keep these runtimes out of the ordinary
  provider registry until live proof exists
