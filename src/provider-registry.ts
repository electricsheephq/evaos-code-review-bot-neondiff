import { redactSecrets } from "./secrets.js";
import type { ProviderStructuredOutputMode } from "./providers.js";

export type ProviderFamilyId =
  | "glm"
  | "openai-compatible"
  | "ollama"
  | "anthropic"
  | "openai"
  | "gemini";

export type ProviderTransport =
  | "zai-chat-completions"
  | "openai-compatible-chat-completions"
  | "anthropic-messages"
  | "openai-responses-or-chat-completions"
  | "gemini-generate-content";

export type ProviderLocality = "local" | "remote" | "local-or-remote";
export type ProviderSupport = boolean | "unknown";
export type ProviderByokPosture = "required" | "optional" | "not-required" | "delegated";

export interface ProviderAuthHint {
  envVar?: string;
  description: string;
}

export interface ProviderFamily {
  id: ProviderFamilyId | string;
  displayName: string;
  aliases: readonly string[];
  transport: ProviderTransport;
  apiShape: string;
  authHints: readonly ProviderAuthHint[];
  locality: ProviderLocality;
  supportsJsonMode: ProviderSupport;
  structuredOutputModes: readonly ProviderStructuredOutputMode[];
  supportsToolUse: ProviderSupport;
  riskNotes: readonly string[];
  byok: {
    posture: ProviderByokPosture;
    notes: string;
  };
}

const publicProviderFamilyBrand: unique symbol = Symbol("PublicProviderFamily");

export interface PublicProviderFamily extends Omit<ProviderFamily, "authHints" | "riskNotes" | "byok"> {
  readonly [publicProviderFamilyBrand]: true;
  authHints: readonly ProviderAuthHint[];
  riskNotes: readonly string[];
  byok: {
    posture: ProviderByokPosture;
    notes: string;
  };
}

export interface ProviderCatalogDuplicate {
  value: string;
  firstProviderId: string;
  duplicateProviderId: string;
}

export interface ProviderCatalogValidation {
  ok: boolean;
  duplicates: ProviderCatalogDuplicate[];
}

export const PROVIDER_FAMILY_CATALOG = [
  {
    id: "glm",
    displayName: "GLM / Z.ai",
    aliases: ["z.ai", "zai", "zcode", "zcode-glm", "glm-5", "glm-5.2"],
    transport: "zai-chat-completions",
    apiShape: "Z.ai GLM chat-completions style API, currently reached through the local ZCode path.",
    authHints: [
      {
        envVar: "ZCODE_API_KEY",
        description: "Used by the local ZCode runtime; do not place the value in tracked config."
      }
    ],
    locality: "remote",
    supportsJsonMode: true,
    structuredOutputModes: ["json-object"],
    supportsToolUse: "unknown",
    riskNotes: [
      "Hosted provider; review prompts and repository excerpts can leave the local machine.",
      "Existing live execution is ZCode-backed; direct GLM adapter parity still needs fixture proof."
    ],
    byok: {
      posture: "delegated",
      notes: "Credentials are delegated to the existing local ZCode app configuration."
    }
  },
  {
    id: "openai-compatible",
    displayName: "OpenAI-Compatible API",
    aliases: [
      "openai-compatible-api",
      "openai-compatible-endpoint",
      "openrouter",
      "vllm",
      "lm-studio",
      "lms",
      "llama.cpp",
      "llama-cpp",
      "llama-server",
      "sglang",
      "internal-gateway"
    ],
    transport: "openai-compatible-chat-completions",
    apiShape: "OpenAI-style /v1/chat/completions and /v1/models endpoints.",
    authHints: [
      {
        envVar: "NEONDIFF_PROVIDER_API_KEY",
        description: "Optional bearer token environment variable for hosted or internal gateways."
      }
    ],
    locality: "local-or-remote",
    supportsJsonMode: "unknown",
    structuredOutputModes: [
      "json-object",
      "openai-json-schema",
      "llama-cpp-json-schema",
      "vllm-structured-outputs",
      "vllm-guided-json",
      "sglang-json-schema"
    ],
    supportsToolUse: "unknown",
    riskNotes: [
      "Compatibility varies by gateway and model; validate JSON output and context behavior before promotion.",
      "Hosted gateways can receive repository excerpts; local gateways depend on operator network binding."
    ],
    byok: {
      posture: "optional",
      notes: "Local endpoints may use no key; hosted and internal gateways should use env-var backed BYOK."
    }
  },
  {
    id: "ollama",
    displayName: "Ollama / Local",
    aliases: ["ollama-local", "local-ollama", "local-model"],
    transport: "openai-compatible-chat-completions",
    apiShape: "Ollama OpenAI-compatible /v1 API when enabled by the local runtime.",
    authHints: [
      {
        description: "No API key is normally required for loopback Ollama."
      }
    ],
    locality: "local",
    supportsJsonMode: "unknown",
    structuredOutputModes: ["json-object", "ollama-format-json-schema"],
    supportsToolUse: "unknown",
    riskNotes: [
      "No-egress posture depends on using a loopback endpoint and a local model.",
      "Model quality, context limits, and JSON reliability vary by downloaded model."
    ],
    byok: {
      posture: "not-required",
      notes: "Uses a locally running Ollama service rather than a hosted API key."
    }
  },
  {
    id: "anthropic",
    displayName: "Anthropic",
    aliases: ["claude", "anthropic-claude"],
    transport: "anthropic-messages",
    apiShape: "Anthropic Messages API.",
    authHints: [
      {
        envVar: "ANTHROPIC_API_KEY",
        description: "Anthropic API key environment variable."
      }
    ],
    locality: "remote",
    supportsJsonMode: false,
    structuredOutputModes: [],
    supportsToolUse: true,
    riskNotes: [
      "Hosted provider; review prompts and repository excerpts can leave the local machine.",
      "Schema-constrained output should be validated through adapter fixtures before runtime promotion."
    ],
    byok: {
      posture: "required",
      notes: "Operator supplies an Anthropic key through the environment."
    }
  },
  {
    id: "openai",
    displayName: "OpenAI",
    aliases: ["openai-native", "gpt", "chatgpt"],
    transport: "openai-responses-or-chat-completions",
    apiShape: "OpenAI Responses API or Chat Completions API.",
    authHints: [
      {
        envVar: "OPENAI_API_KEY",
        description: "OpenAI API key environment variable."
      }
    ],
    locality: "remote",
    supportsJsonMode: true,
    structuredOutputModes: ["json-object", "openai-json-schema"],
    supportsToolUse: true,
    riskNotes: [
      "Hosted provider; review prompts and repository excerpts can leave the local machine.",
      "Choose project and data controls appropriate to the repository sensitivity."
    ],
    byok: {
      posture: "required",
      notes: "Operator supplies an OpenAI key through the environment."
    }
  },
  {
    id: "gemini",
    displayName: "Gemini / Google AI",
    aliases: ["google-ai", "google-gemini", "vertex-gemini", "vertex-ai"],
    transport: "gemini-generate-content",
    apiShape: "Gemini generateContent API or compatible Vertex AI surface.",
    authHints: [
      {
        envVar: "GEMINI_API_KEY",
        description: "Google AI Studio API key environment variable."
      },
      {
        envVar: "GOOGLE_APPLICATION_CREDENTIALS",
        description: "Optional Vertex AI application credentials file path."
      }
    ],
    locality: "remote",
    supportsJsonMode: true,
    structuredOutputModes: ["json-object"],
    supportsToolUse: true,
    riskNotes: [
      "Hosted provider; review prompts and repository excerpts can leave the local machine.",
      "Google AI Studio and Vertex AI have different auth and data-governance postures."
    ],
    byok: {
      posture: "required",
      notes: "Operator supplies Google credentials through environment-backed configuration."
    }
  }
] satisfies readonly ProviderFamily[];

export function listProviderFamilies(catalog: readonly ProviderFamily[] = PROVIDER_FAMILY_CATALOG): ProviderFamily[] {
  return catalog.map((provider) => cloneProviderFamily(provider));
}

export function findProviderFamily(
  idOrAlias: string,
  catalog: readonly ProviderFamily[] = PROVIDER_FAMILY_CATALOG
): ProviderFamily | undefined {
  const normalizedNeedle = normalizeProviderKey(idOrAlias);
  const provider = catalog.find((entry) => providerLookupKeys(entry).some((key) => key === normalizedNeedle));
  return provider ? cloneProviderFamily(provider) : undefined;
}

export function validateProviderFamilyCatalog(
  catalog: readonly ProviderFamily[] = PROVIDER_FAMILY_CATALOG
): ProviderCatalogValidation {
  const seen = new Map<string, { providerId: string; entryIndex: number }>();
  const duplicates: ProviderCatalogDuplicate[] = [];

  for (const [entryIndex, provider] of catalog.entries()) {
    for (const key of providerLookupKeys(provider)) {
      const first = seen.get(key);
      if (first && first.entryIndex !== entryIndex) {
        duplicates.push({
          value: key,
          firstProviderId: first.providerId,
          duplicateProviderId: provider.id
        });
        continue;
      }
      seen.set(key, { providerId: provider.id, entryIndex });
    }
  }

  return {
    ok: duplicates.length === 0,
    duplicates
  };
}

export function toPublicProviderFamilies(
  catalog: readonly ProviderFamily[] = PROVIDER_FAMILY_CATALOG
): PublicProviderFamily[] {
  return catalog.map((provider) => toPublicProviderFamily(provider));
}

export function toPublicProviderFamily(provider: ProviderFamily): PublicProviderFamily {
  return {
    [publicProviderFamilyBrand]: true,
    id: redactProviderPublicText(provider.id),
    displayName: redactProviderPublicText(provider.displayName),
    aliases: provider.aliases.map((alias) => redactProviderPublicText(alias)),
    transport: provider.transport,
    apiShape: redactProviderPublicText(provider.apiShape),
    authHints: provider.authHints.map((hint) => ({
      ...(hint.envVar ? { envVar: redactProviderPublicText(hint.envVar) } : {}),
      description: redactProviderPublicText(hint.description)
    })),
    locality: provider.locality,
    supportsJsonMode: provider.supportsJsonMode,
    structuredOutputModes: [...provider.structuredOutputModes],
    supportsToolUse: provider.supportsToolUse,
    riskNotes: provider.riskNotes.map((note) => redactProviderPublicText(note)),
    byok: {
      posture: provider.byok.posture,
      notes: redactProviderPublicText(provider.byok.notes)
    }
  };
}

function providerLookupKeys(provider: ProviderFamily): string[] {
  return [provider.id, ...provider.aliases].map((key) => normalizeProviderKey(key));
}

function normalizeProviderKey(value: string): string {
  return value.trim().toLowerCase();
}

function redactProviderPublicText(value: string): string {
  return redactSecrets(value)
    .replace(/\bsk-[A-Za-z0-9._-]{8,}\b/g, "[redacted-secret]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-secret]");
}

function cloneProviderFamily(provider: ProviderFamily): ProviderFamily {
  return {
    ...provider,
    aliases: [...provider.aliases],
    structuredOutputModes: [...provider.structuredOutputModes],
    authHints: provider.authHints.map((hint) => ({ ...hint })),
    riskNotes: [...provider.riskNotes],
    byok: { ...provider.byok }
  };
}
