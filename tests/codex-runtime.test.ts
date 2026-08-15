import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildCodexExecInvocation,
  buildCodexRuntimeEnv,
  CODEX_REVIEW_FINDINGS_JSON_SCHEMA,
  runCodexReview,
  runCodexStructuredOutput
} from "../src/codex-runtime.js";
import { buildReviewProviderMetadata, resolveSelfConsistencyBackend } from "../src/worker.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex CLI review runtime", () => {
  it("is opt-in and accepts Luna with Max reasoning", () => {
    expect(loadConfigFromObject({}).codexRuntime?.enabled).toBe(false);
    const config = loadConfigFromObject({
      codexRuntime: {
        enabled: true,
        cliPath: "/Users/test/.local/bin/codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        timeoutMs: 300_000,
        maxOutputBytes: 20 * 1024 * 1024,
        contextWindowTokens: 128_000
      }
    });
    expect(config.codexRuntime).toMatchObject({
      enabled: true,
      model: "gpt-5.6-luna",
      reasoningEffort: "max"
    });
    expect(buildReviewProviderMetadata(config)).toMatchObject({
      providerId: "codex-cli-oauth",
      adapter: "codex-cli",
      model: "gpt-5.6-luna"
    });
  });

  it("constructs a read-only ephemeral invocation without OAuth material", () => {
    const invocation = buildCodexExecInvocation({
      cliPath: "/Users/test/.local/bin/codex",
      cwd: "/private/tmp/review-worktree",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      schemaPath: "/private/tmp/evidence/schema.json",
      outputPath: "/private/tmp/evidence/result.json"
    });

    expect(invocation.command).toBe("/Users/test/.local/bin/codex");
    expect(invocation.args).toEqual([
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--disable", "apps",
      "--disable", "multi_agent",
      "--disable", "multi_agent_v2",
      "-c", "approval_policy=\"never\"",
      "-c", "model_reasoning_effort=\"max\"",
      "--model", "gpt-5.6-luna",
      "--sandbox", "read-only",
      "--cd", "/private/tmp/review-worktree",
      "--output-schema", "/private/tmp/evidence/schema.json",
      "--output-last-message", "/private/tmp/evidence/result.json",
      "--color", "never",
      "-"
    ]);
    expect(invocation.args.join(" ")).not.toContain("dangerously-bypass");
  });

  it("keeps every strict Codex finding property required while nullable fields remain optional to NeonDiff", () => {
    const itemSchema = CODEX_REVIEW_FINDINGS_JSON_SCHEMA.properties.findings.items;

    expect(new Set(itemSchema.required)).toEqual(new Set(Object.keys(itemSchema.properties)));
    expect(itemSchema.properties.category.type).toEqual(["string", "null"]);
    expect(itemSchema.properties.why_this_matters.type).toEqual(["string", "null"]);
  });

  it("passes only the bounded environment required for Codex auth and transport", () => {
    const env = buildCodexRuntimeEnv({
      HOME: "/Users/test",
      USER: "test",
      PATH: "/usr/bin:/bin",
      CODEX_HOME: "/Users/test/.codex",
      HTTPS_PROXY: "https://proxy.invalid",
      GITHUB_TOKEN: "must-not-pass",
      OPENAI_API_KEY: "must-not-pass",
      EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH: "/private/key.pem"
    });

    expect(env).toEqual({
      HOME: "/Users/test",
      USER: "test",
      PATH: "/usr/bin:/bin",
      CODEX_HOME: "/Users/test/.codex",
      HTTPS_PROXY: "https://proxy.invalid"
    });
  });

  it("validates schema output and fails closed if the checkout changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-codex-runtime-"));
    temporaryRoots.push(root);
    const evidenceDir = join(root, "evidence");
    const snapshots = ["clean", "clean"];
    const result = await runCodexReview({
      cwd: join(root, "worktree"),
      prompt: "Return one fixture finding.",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      evidenceDir,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    }, {
      captureWorktreeState: () => snapshots.shift()!,
      runProcess: async (invocation) => {
        writeFileSync(invocation.outputPath, JSON.stringify({
          findings: [{
            severity: "P1",
            path: "src/example.ts",
            line: 12,
            title: "Fixture finding",
            body: "The fixture proves schema parsing.",
            confidence: 0.99
          }]
        }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });

    expect(result.findings).toHaveLength(1);
    expect(result.droppedFromSchema).toEqual([]);
    expect(JSON.parse(readFileSync(join(evidenceDir, "codex-review-schema.json"), "utf8"))).toHaveProperty("properties.findings");

    const changedSnapshots = ["before", "after"];
    await expect(runCodexReview({
      cwd: join(root, "worktree"),
      prompt: "Return no findings.",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      evidenceDir: join(root, "changed-evidence"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    }, {
      captureWorktreeState: () => changedSnapshots.shift()!,
      runProcess: async (invocation) => {
        writeFileSync(invocation.outputPath, JSON.stringify({ findings: [] }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    })).rejects.toThrow("codex_runtime_unsafe_write_attempt");
  });

  it("supports a named strict structured result without weakening the read-only runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-codex-structured-"));
    temporaryRoots.push(root);
    const evidenceDir = join(root, "evidence");
    const result = await runCodexStructuredOutput({
      cwd: join(root, "worktree"),
      prompt: "Return the fixture classification.",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      evidenceDir,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      artifactPrefix: "codex-issue-analysis",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["classification"],
        properties: {
          classification: { type: "string", enum: ["bug"] }
        }
      },
      parse: (value) => {
        if (
          typeof value !== "object" ||
          value === null ||
          !("classification" in value) ||
          value.classification !== "bug"
        ) {
          throw new Error("invalid fixture");
        }
        return { classification: "bug" as const };
      }
    }, {
      captureWorktreeState: () => "clean",
      runProcess: async (invocation) => {
        writeFileSync(invocation.outputPath, JSON.stringify({ classification: "bug" }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });

    expect(result.value).toEqual({ classification: "bug" });
    expect(result.rawResponse).toBe('{"classification":"bug"}');
    expect(JSON.parse(readFileSync(join(evidenceDir, "codex-issue-analysis-schema.json"), "utf8")))
      .toHaveProperty("properties.classification");
    expect(readFileSync(join(evidenceDir, "codex-issue-analysis-result.json"), "utf8"))
      .toContain('"classification":"bug"');
  });

  it("replaces a rejected secret-like result artifact before failing closed", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-codex-secret-result-"));
    temporaryRoots.push(root);
    const evidenceDir = join(root, "evidence");
    const fixtureToken = ["super", "secret", "token"].join("-");

    await expect(runCodexReview({
      cwd: join(root, "worktree"),
      prompt: "Return the fixture result.",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      evidenceDir,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024
    }, {
      captureWorktreeState: () => "clean",
      runProcess: async (invocation) => {
        writeFileSync(invocation.outputPath, JSON.stringify({
          findings: [{
            severity: "P1",
            path: "src/example.ts",
            line: 12,
            title: "Fixture finding",
            body: `Leaked ${fixtureToken}`,
            confidence: 0.99
          }]
        }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    })).rejects.toThrow("codex_runtime_secret_output");

    const retained = readFileSync(join(evidenceDir, "codex-review-result.json"), "utf8");
    expect(retained).not.toContain(fixtureToken);
    expect(retained).toContain("rejected-secret-like-output");
  });

  it("keeps default self-consistency draws on the active Codex backend", () => {
    const config = loadConfigFromObject({
      codexRuntime: {
        enabled: true,
        cliPath: "/Users/test/.local/bin/codex",
        model: "gpt-5.6-luna",
        reasoningEffort: "max",
        timeoutMs: 300_000,
        maxOutputBytes: 20 * 1024 * 1024,
        contextWindowTokens: 128_000
      }
    });

    expect(resolveSelfConsistencyBackend(config, { enabled: true })).toEqual({
      useCodex: true,
      providerId: "codex-cli-oauth"
    });
    expect(resolveSelfConsistencyBackend(config, {
      enabled: true,
      provider: "zcode-glm"
    })).toEqual({
      useCodex: false,
      providerId: "zcode-glm"
    });
  });
});
