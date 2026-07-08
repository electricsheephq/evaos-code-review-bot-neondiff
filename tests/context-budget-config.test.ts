import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";

describe("context budget config", () => {
  it("loads conservative skip-first defaults", () => {
    const config = loadConfigFromObject({});

    expect(config.contextBudget).toMatchObject({
      enabled: true,
      overflow: "skip",
      reservedOutputTokens: 4096,
      charsPerToken: 4,
      providerFudgeFactor: 1.15,
      maxChunks: 8
    });
  });

  it("accepts chunk-mode overrides", () => {
    const config = loadConfigFromObject({
      contextBudget: {
        enabled: true,
        overflow: "chunk",
        reservedOutputTokens: 2048,
        charsPerToken: 3,
        providerFudgeFactor: 1.3,
        maxChunks: 4
      }
    });

    expect(config.contextBudget).toMatchObject({
      enabled: true,
      overflow: "chunk",
      reservedOutputTokens: 2048,
      charsPerToken: 3,
      providerFudgeFactor: 1.3,
      maxChunks: 4
    });
  });

  it("rejects unsafe or nonsensical context budget settings", () => {
    expect(() => loadConfigFromObject({ contextBudget: { enabled: "yes" } })).toThrow(
      "config.contextBudget.enabled must be a boolean"
    );
    expect(() => loadConfigFromObject({ contextBudget: { overflow: "truncate" } })).toThrow(
      "config.contextBudget.overflow must be skip or chunk"
    );
    expect(() => loadConfigFromObject({ contextBudget: { reservedOutputTokens: 0 } })).toThrow(
      "config.contextBudget.reservedOutputTokens must be a positive integer"
    );
    expect(() => loadConfigFromObject({ contextBudget: { charsPerToken: 0 } })).toThrow(
      "config.contextBudget.charsPerToken must be a positive integer"
    );
    expect(() => loadConfigFromObject({ contextBudget: { providerFudgeFactor: 0 } })).toThrow(
      "config.contextBudget.providerFudgeFactor must be a positive finite number"
    );
    expect(() => loadConfigFromObject({ contextBudget: { maxChunks: 0 } })).toThrow(
      "config.contextBudget.maxChunks must be a positive integer"
    );
  });
});
