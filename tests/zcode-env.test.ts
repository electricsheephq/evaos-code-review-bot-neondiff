import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveZCodeProviderEnv } from "../src/zcode-env.js";

describe("ZCode provider env", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("derives transient CLI env from the enabled GLM provider without logging the key", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-env-"));
    roots.push(root);
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        provider: {
          "builtin:zai-coding-plan": {
            enabled: true,
            kind: "anthropic",
            options: {
              apiKey: "zai-secret-key",
              baseURL: "https://api.z.ai/api/anthropic"
            },
            models: {
              "GLM-5.2": {}
            }
          }
        }
      })
    );

    const env = resolveZCodeProviderEnv({ appConfigPath: configPath, model: "GLM-5.2" });

    expect(env.ZCODE_MODEL).toBe("builtin:zai-coding-plan/GLM-5.2");
    expect(env.ZCODE_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(env.ZCODE_API_KEY).toBe("zai-secret-key");
    expect(JSON.stringify(env.redacted)).not.toContain("zai-secret-key");
  });
});
