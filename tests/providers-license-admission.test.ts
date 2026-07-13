import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { runProvidersVerifyCommand } from "../src/providers-verify-command.js";

describe("providers verify license admission", () => {
  it("denies before provider-key stdin or provider network", async () => {
    const config = loadConfigFromObject({
      pilotRepos: [],
      workRoot: "/tmp/neondiff-provider-admission/runtime",
      statePath: "/tmp/neondiff-provider-admission/state.sqlite",
      evidenceDir: "/tmp/neondiff-provider-admission/evidence"
    });
    let stdinReads = 0;
    let providerCalls = 0;
    const result = await runProvidersVerifyCommand({
      apiKeyStdin: "true",
      stdin: Readable.from(["provider-key-that-must-not-be-read"])
    }, {
      loadConfig: () => config,
      requireActiveProductionLicense: async () => ({
        ok: false,
        decision: {
          status: "missing",
          checkedAt: "2026-07-11T00:00:00.000Z",
          classification: "missing",
          detail: "license activation is required"
        }
      }),
      readSecretFromStdin: async () => {
        stdinReads += 1;
        return "provider-key";
      },
      verifyProviderApiKey: async () => {
        providerCalls += 1;
        throw new Error("provider must not be called");
      }
    } as any);

    expect(result).toMatchObject({
      exitCode: 1,
      output: { ok: false, command: "providers verify", error: expect.stringContaining("activation is required") }
    });
    expect(stdinReads).toBe(0);
    expect(providerCalls).toBe(0);
  });
});
