import { describe, expect, it } from "vitest";
import {
  PROVIDER_FAMILY_CATALOG,
  findProviderFamily,
  listProviderFamilies,
  toPublicProviderFamily,
  toPublicProviderFamilies,
  validateProviderFamilyCatalog
} from "../src/provider-registry.js";

describe("provider family catalog", () => {
  it("lists supported provider families in deterministic registry order", () => {
    expect(listProviderFamilies().map((provider) => provider.id)).toEqual([
      "glm",
      "openai-compatible",
      "ollama",
      "anthropic",
      "openai",
      "gemini"
    ]);
  });

  it("finds providers by id and alias without case-sensitive caller coupling", () => {
    expect(findProviderFamily("glm")?.displayName).toBe("GLM / Z.ai");
    expect(findProviderFamily("zcode-glm")?.id).toBe("glm");
    expect(findProviderFamily("z.ai")?.id).toBe("glm");
    expect(findProviderFamily("ZCODE")?.id).toBe("glm");
    expect(findProviderFamily("openai-compatible-api")?.id).toBe("openai-compatible");
    expect(findProviderFamily("ollama-local")?.id).toBe("ollama");
    expect(findProviderFamily("claude")?.id).toBe("anthropic");
    expect(findProviderFamily("google-ai")?.id).toBe("gemini");
    expect(findProviderFamily("missing-provider")).toBeUndefined();
  });

  it("validates duplicate provider ids and aliases across custom catalogs", () => {
    const aliasValidation = validateProviderFamilyCatalog([
      ...PROVIDER_FAMILY_CATALOG,
      {
        ...PROVIDER_FAMILY_CATALOG[0],
        id: "glm-canary",
        aliases: ["z.ai", "glm-canary"]
      }
    ]);

    expect(aliasValidation.ok).toBe(false);
    expect(aliasValidation.duplicates).toEqual([
      { value: "z.ai", firstProviderId: "glm", duplicateProviderId: "glm-canary" }
    ]);

    const idValidation = validateProviderFamilyCatalog([
      ...PROVIDER_FAMILY_CATALOG,
      {
        ...PROVIDER_FAMILY_CATALOG[0],
        aliases: ["glm-canary"]
      }
    ]);
    expect(idValidation.ok).toBe(false);
    expect(idValidation.duplicates).toContainEqual({
      value: "glm",
      firstProviderId: "glm",
      duplicateProviderId: "glm"
    });
  });

  it("keeps public metadata free of secret-looking auth values", () => {
    const providerWithAccidentalSecret = {
      ...PROVIDER_FAMILY_CATALOG.find((provider) => provider.id === "openai")!,
      authHints: [
        {
          envVar: "OPENAI_API_KEY",
          description: "OpenAI API key",
          secretValue: "sk-live-accidental-secret"
        }
      ],
      riskNotes: [
        "Hosted API; repository excerpts leave the local machine.",
        "Accidental token sk-live-accidental-secret must not leak."
      ]
    };

    const publicProvider = toPublicProviderFamily(providerWithAccidentalSecret);
    const publicCatalog = toPublicProviderFamilies([providerWithAccidentalSecret]);
    const serialized = JSON.stringify({ publicProvider, publicCatalog });

    expect(serialized).toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("sk-live-accidental-secret");
    expect(serialized).toContain("[redacted-secret]");

    const geminiProvider = {
      ...PROVIDER_FAMILY_CATALOG.find((provider) => provider.id === "gemini")!,
      riskNotes: [
        "Accidental Google key AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx must not leak."
      ]
    };
    const geminiSerialized = JSON.stringify(toPublicProviderFamily(geminiProvider));
    expect(geminiSerialized).not.toContain("AIzaSyDxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(geminiSerialized).toContain("[redacted-secret]");
  });
});
