# NeonDiff Provider Registry

NeonDiff is local-first for checkout state, evidence, credentials, and operator
control. Repository prompts and diffs can still leave the worker when you choose
a hosted model provider such as ZCode-backed GLM/Z.ai or a hosted
OpenAI-compatible gateway. For no-egress review, use a local model runtime. Do
not paste provider API keys into tracked config, GitHub comments, release notes,
or evidence packets.

The current live review engine remains ZCode-backed. The provider registry is
the public setup and operator surface for declaring available providers before
alternate adapter execution is promoted.

## Resource Links

Official/provider-owned docs:

- [Z.AI quick start](https://docs.z.ai/guides/overview/quick-start)
- [Z.AI API reference](https://docs.z.ai/api-reference/introduction)
- [Z.AI OpenAI SDK compatibility](https://docs.z.ai/guides/develop/openai/python)
- [Z.AI current GLM coding model guidance](https://docs.z.ai/devpack/latest-model)
- [Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)

Discovery/resource catalogs:

- [cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources)

External catalogs are volatile resource directories. Treat them as a place to
find candidates, quotas, and trial/free-tier notes, not as evidence that a
provider can run NeonDiff reviews. A provider moves from "resource" to
"compatible" or "tested" only after the relevant NeonDiff proof issue records
fixture, doctor/smoke, redaction, duplicate-suppression, and release-status
evidence.

## NeonDiff-Tested Compatibility Matrix

Status definitions:

- `default beta path`: shipped live review route in this beta.
- `tested by NeonDiff`: covered by NeonDiff fixture, doctor, smoke, or live-route
  proof named in repo evidence; this still does not claim quality parity.
- `compatible by interface`: the provider exposes an API shape NeonDiff can
  declare or smoke, but live review promotion still needs proof.
- `tracked/planned`: work is filed, but runtime support is not shipped.
- `resource only / untested`: useful external reference, not NeonDiff
  compatibility truth.

| Provider, runtime, or resource | Status | How to verify | Egress posture | Tracking |
| --- | --- | --- | --- | --- |
| GLM/Z.AI through ZCode (`zcode-glm`) | `default beta path`; `tested by NeonDiff` as the current live review route | `neondiff providers doctor --config config.local.json --json`, then a dry-run review before live posting | Hosted Z.AI/GLM path through ZCode can receive prompts and diffs | Provider sprint [#238](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/238) |
| Ollama on `http://localhost:11434/v1` | `compatible by interface`; provider doctor/smoke only until adapter proof promotes live review | Enable the local provider and run `neondiff providers doctor --config config.local.json --provider ollama-local --smoke true --json` | No-egress only when endpoint is loopback or self-hosted and the model runs locally | OpenAI-compatible adapter [#240](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/240) |
| LM Studio, vLLM, or local OpenAI-compatible gateway | `compatible by interface`; `tracked/planned` for live adapter proof | Use an explicit provider id and local `/v1` base URL; promote only after fixture and dry-run review proof | No-egress only for local/self-hosted endpoints; hosted gateways are remote egress | OpenAI-compatible adapter [#240](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/240) |
| Hosted OpenAI-compatible BYOK gateway | `compatible by interface`; remote smoke and live review proof required | Store only `apiKeyEnv`, run a single-provider smoke, then record redacted evidence before live review | Hosted provider receives prompts and diffs | Hosted BYOK coverage [#241](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/241) |
| Free/trial provider catalogs such as `cheahjs/free-llm-api-resources` | `resource only / untested` unless a provider has a NeonDiff proof issue | Verify provider terms, model availability, OpenAI compatibility, quota, and NeonDiff proof separately | Usually hosted egress; read each provider's terms and privacy posture | This resource issue [#242](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/242) |
| Agent runtimes such as Codex CLI, Claude Code, and OpenCode | `tracked/planned`; discovery only | Do not configure as a live review provider until the runtime contract is documented and proven | Depends on each runtime/provider chain; no general no-egress claim | Agent runtime discovery [#243](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/243) |

## Commands

List configured providers without printing secrets:

```bash
neondiff providers list --config config.local.json --json
```

Check enabled provider metadata:

```bash
neondiff providers doctor --config config.local.json --json
```

Smoke an OpenAI-compatible `/models` endpoint:

```bash
neondiff providers doctor \
  --config config.local.json \
  --provider ollama-local \
  --smoke true \
  --json
```

The example `ollama-local` provider is disabled by default. Enable it in
`config.local.json` or with a dry-run-verified config patch before running the
smoke command; otherwise the doctor exits before calling `/models`. Smoke checks
are local-loopback only in this beta and must include `--provider` so a single
command cannot fan out authenticated requests to every enabled provider.

## GLM/Z.ai Through ZCode

The default beta provider is `zcode-glm`. It delegates auth and endpoint
resolution to the local ZCode app config referenced by `zcode.appConfigPath`.
NeonDiff derives a transient runtime environment for the ZCode child process and
writes only redacted provider metadata into evidence.

```json
{
  "providers": {
    "defaultProviderId": "zcode-glm",
    "providers": {
      "zcode-glm": {
        "enabled": true,
        "adapter": "zcode",
        "model": "GLM-5.2",
        "authMode": "zcode-app-config",
        "capabilities": {
          "review": true,
          "jsonOutput": true,
          "local": false,
          "streaming": false
        }
      }
    }
  }
}
```

## Ollama Or OpenAI-Compatible Endpoint

Ollama, LM Studio, vLLM, local gateways, and hosted gateways can be described as
`openai-compatible` when they expose an OpenAI-style API. Local Ollama normally
does not need an API key:

```json
{
  "providers": {
    "providers": {
      "ollama-local": {
        "enabled": true,
        "adapter": "openai-compatible",
        "baseUrl": "http://localhost:11434/v1",
        "model": "qwen2.5-coder:7b",
        "authMode": "none",
        "capabilities": {
          "review": true,
          "jsonOutput": true,
          "local": true,
          "streaming": false
        }
      }
    }
  }
}
```

For BYOK gateways, store only an uppercase environment variable name in config.
This field must not store the API key:

```json
{
  "providers": {
    "providers": {
      "openai-compatible": {
        "enabled": true,
        "adapter": "openai-compatible",
        "baseUrl": "https://gateway.example.com/v1",
        "model": "model-id",
        "authMode": "api-key-env",
        "apiKeyEnv": "NEONDIFF_PROVIDER_API_KEY",
        "capabilities": {
          "review": true,
          "jsonOutput": true,
          "local": false,
          "streaming": false
        }
      }
    }
  }
}
```

Then export the key in the operator wrapper, not in JSON:

```bash
export NEONDIFF_PROVIDER_API_KEY="..."
neondiff providers doctor --config config.local.json --provider openai-compatible --smoke true --json
```

## Agent Runtime Adapters

Codex CLI, Claude Code, and OpenCode are not ordinary provider adapters in this
registry. Treat them as discovery-stage agent-runtime adapter or invocation
plugin candidates: their CLIs may call tools, read a checkout, use their own
model/provider settings, and produce review output after an agent loop.

NeonDiff does not currently claim live review support for Codex CLI, Claude
Code, or OpenCode. Do not list them as provider registry entries until a later
implementation proves a bounded no-write runtime contract, schema-valid output,
redacted evidence, timeout/error handling, and current-head review behavior. The
discovery contract is documented in
[docs/agent-runtime-adapters.md](agent-runtime-adapters.md).

## Error Categories

Provider checks normalize common failures into these categories:

- `auth`
- `quota_or_rate_limit`
- `transient`
- `timeout`
- `context_limit`
- `model_output_schema`
- `unknown`

Retries and cooldowns must stay bounded and observable. A transient provider
error should not kill the daemon or globally pause unrelated providers.

Adapter fixture execution uses a narrower provider-runtime classification for
mocked adapter runs:

- `auth`
- `throttle`
- `network`
- `timeout`
- `model-output`
- `unknown`

Fixture evidence is deterministic after redaction: it records fixture, provider,
adapter, model, prompt hashes, redacted-output hashes, redacted output previews,
and bounded raw-evidence previews. Redacted-output hashes fingerprint only the
operator-visible redacted projection, not raw provider output. Raw-evidence
previews remove or replace private-looking keys and fail closed for secret-like
values, fixture prompts, and diff-shaped text. Treat the preview as an operator
debugging aid, not as a blanket public-safe guarantee for arbitrary provider
payloads. Fixtures prove adapter contract behavior and evidence boundary
handling. They do not prove live provider parity, provider quality, cooldown
behavior, production runtime selection, or exhaustive redaction of every
possible private value.

## Proof Boundary

This registry does not claim CodeRabbit parity, calibrated review accuracy, or
that all listed providers can execute live reviews. A provider should be promoted
to live review only after mocked adapter tests, fixture review proof, redaction
proof, duplicate-suppression proof, and release-status evidence pass.
