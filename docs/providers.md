# NeonDiff Provider Registry

NeonDiff is local-first: repository data stays on the worker machine and model
credentials stay in local app config, environment variables, Keychain-backed
wrappers, or a local model runtime. Do not paste provider API keys into tracked
config, GitHub comments, release notes, or evidence packets.

The current live review engine remains ZCode-backed. The provider registry is
the public setup and operator surface for declaring available providers before
alternate adapter execution is promoted.

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

For BYOK gateways, store only the environment variable name in config. This
field must not store the API key:

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

## Proof Boundary

This registry does not claim CodeRabbit parity, calibrated review accuracy, or
that all listed providers can execute live reviews. A provider should be promoted
to live review only after mocked adapter tests, fixture review proof, redaction
proof, duplicate-suppression proof, and release-status evidence pass.
