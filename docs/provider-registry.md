# Provider Registry Catalog

NeonDiff keeps provider choice local-first and BYOK-oriented. The provider
registry catalog lists supported provider families and the metadata operators
need before wiring a provider into config validation or runtime adapters.

This catalog is not a claim that every provider family should be selected for
live reviews by default. The current default beta route remains ZCode-backed
unless an operator explicitly selects another provider after the proof gates
documented in `docs/providers.md`. A provider family should be promoted to
routine runtime support only after fixture review proof, redaction proof, bounded
retry behavior, cooldown behavior, and release-status evidence are available.

## Provider Families

- `glm`: GLM / Z.ai through the existing ZCode path. Auth is delegated to the
  local ZCode configuration; do not publish key values in GitHub comments,
  config examples, logs, or evidence packets.
- `openai-compatible`: OpenAI-compatible APIs such as internal gateways,
  OpenRouter-style gateways, vLLM, LM Studio, or other `/v1` endpoints. Local
  endpoints may need no key; hosted endpoints should use an environment
  variable such as `NEONDIFF_PROVIDER_API_KEY`.
- `ollama`: Local Ollama through its OpenAI-compatible API surface. This is the
  preferred no-egress family when the endpoint is loopback and the model is
  local.
- `anthropic`: Anthropic Messages API. Use `ANTHROPIC_API_KEY` from the
  operator environment. Native adapter smoke uses an empty-findings review
  fixture and Anthropic's JSON-schema output configuration.
- `openai`: OpenAI Responses or Chat Completions API. Use `OPENAI_API_KEY` from
  the operator environment. Native adapter smoke uses Chat Completions structured
  outputs.
- `gemini`: Gemini / Google AI or Vertex AI surfaces. Use `GEMINI_API_KEY` or
  `GOOGLE_APPLICATION_CREDENTIALS` from the operator environment. Native adapter
  smoke uses generateContent JSON response schema controls.

## Public Metadata

Public registry output is safe to include in docs or evidence because it
contains environment variable names, not secret values. If a secret-like value
is accidentally added to auth hints or risk notes, callers should use the public
catalog helper so the value is redacted before serialization.

The catalog metadata includes:

- provider id and aliases
- display name
- transport and API shape
- auth environment hints without secret values
- local or remote posture
- JSON-mode and tool-use support when known
- risk notes
- BYOK posture

## Implementation Boundary

`src/provider-registry.ts` is a typed catalog and lookup helper layer. It is
intended for config validation, UI copy, and evidence-safe provider summaries.
Provider doctor/smoke, adapter factories, and explicit review selection live in
the runtime/provider modules; non-default rollout still requires explicit config
and proof.
