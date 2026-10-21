import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildCodexExecInvocation,
  buildCodexRuntimeEnv,
  CODEX_REVIEW_FINDINGS_JSON_SCHEMA,
  parseCodexUsage,
  runCodexReview,
  runCodexStructuredOutput
} from "../src/codex-runtime.js";
import { buildReviewProviderMetadata, resolveSelfConsistencyBackend } from "../src/worker.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex CLI review runtime", () => {
  it.each([
    ["model: gpt-6.1-sol\nreasoning effort: high\ntokens used\n43 305\n", 43305],
    ["tokens used\n1 234 567\n", 1234567],
    // Real Codex CLI output groups thousands with U+202F (narrow no-break space).
    ["model: gpt-6.1-sol\nreasoning effort: high\ntokens used\n44\u202f858\n", 44858],
    ["tokens used\n1\u00a0234,567\n", 1234567],
    ["tokens used\n12\u202f34\n", null],
    ["tokens used\nmalformed\n", null],
    ["tokens used\n12x34\n", null],
    ["tokens used\n9007199254740992\n", null],
    ["", null]
  ])("parses bounded usage metadata from stderr", (stderr, tokensUsed) => {
    expect(parseCodexUsage(stderr as string, { model: "gpt-6.1-sol", reasoningEffort: "high" }, 123))
      .toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high", tokensUsed, durationMs: 123 });
  });
  it("records runtime-reported model and effort with safe configured fallbacks", () => {
    expect(parseCodexUsage("model: gpt-6-sol\nreasoning effort: xhigh\ntokens used\n123\n",
      { model: "gpt-6.1-sol", reasoningEffort: "high" }, 9)).toEqual({ model: "gpt-6-sol", reasoningEffort: "xhigh", tokensUsed: 123, durationMs: 9 });
    expect(parseCodexUsage("model: raw prompt text\nreasoning effort: ultra\ntokens used\n12 34\n",
      { model: "gpt-6.1-sol", reasoningEffort: "high" }, 9)).toEqual({ model: "gpt-6.1-sol", reasoningEffort: "high", tokensUsed: null, durationMs: 9 });
  });
  it("defaults to PATH-resolved Sol 6.1/high with 500000 context tokens", () => {
    expect(loadConfigFromObject({ codexRuntime: { enabled: true } }).codexRuntime).toMatchObject({
      cliPath: "codex", model: "gpt-6.1-sol", reasoningEffort: "high", contextWindowTokens: 500000
    });
    expect(() => loadConfigFromObject({ codexRuntime: { enabled: true, cliPath: "./codex" } })).toThrow();
    expect(() => loadConfigFromObject({ codexRuntime: { reasoningEffort: "ultra" } })).toThrow();
  });
  it("requests an original LCM assessment only when the repository opts in", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-lcm-assessment-"));
    temporaryRoots.push(root);
    for (const { enabled, includeAssessment } of [
      { enabled: false, includeAssessment: false },
      { enabled: true, includeAssessment: true },
      { enabled: true, includeAssessment: false }
    ]) {
      const evidenceDir = join(root, `${enabled}-${includeAssessment}`);
      const assessment = { verdict: "ABSTAIN", scope: "Synthetic schema test",
        unresolved_findings: [], limitations: ["No real review ran"],
        acceptance_evidence: ["Test fixture only"] };
      const result = await runCodexReview({
        cwd: root, prompt: "Synthetic schema fixture", cliPath: "/test/codex",
        model: "gpt-6-astra", reasoningEffort: "high", evidenceDir,
        timeoutMs: 1000, maxOutputBytes: 10000, lcmReviewAssessment: enabled
      }, {
        captureWorktreeState: () => "unchanged",
        runProcess: async (invocation) => {
          writeFileSync(invocation.outputPath, JSON.stringify({ findings: [],
            summary: { changedBehavior: ["Fixture"], invariants: ["Original verdict"],
              evidence: ["Fixture"], limitations: ["Mock"], noFindingRationale: "Mock" },
            ...(enabled ? { review_assessment: includeAssessment ? assessment : null } : {}) }));
          return { stdout: "", stderr: "", status: 0, signal: null };
        }
      });
      const schema = JSON.parse(readFileSync(join(evidenceDir, "codex-review-schema.json"), "utf8"));
      expect(schema.required.includes("review_assessment")).toBe(enabled);
      expect("review_assessment" in schema.properties).toBe(enabled);
      expect(JSON.parse(result.rawResponse).review_assessment).toEqual(
        enabled ? (includeAssessment ? assessment : null) : undefined
      );
    }
  });

  it("is opt-in and accepts Sol 6.1 with high reasoning", () => {
    expect(loadConfigFromObject({}).codexRuntime?.enabled).toBe(false);
    const config = loadConfigFromObject({
      codexRuntime: {
        enabled: true,
        cliPath: "/Users/test/.local/bin/codex",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        timeoutMs: 300_000,
        maxOutputBytes: 20 * 1024 * 1024,
        contextWindowTokens: 500_000
      }
    });
    expect(config.codexRuntime).toMatchObject({
      enabled: true,
      model: "gpt-6.1-sol",
      reasoningEffort: "high"
    });
    expect(buildReviewProviderMetadata(config)).toMatchObject({
      providerId: "codex-cli-oauth",
      adapter: "codex-cli",
      model: "gpt-6.1-sol"
    });
  });

  it("constructs a read-only ephemeral invocation without OAuth material", () => {
    const invocation = buildCodexExecInvocation({
      cliPath: "/Users/test/.local/bin/codex",
      cwd: "/private/tmp/review-worktree",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
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
      "-c", "model_reasoning_effort=\"high\"",
      "--model", "gpt-6.1-sol",
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
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
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
          }],
          summary: {
            changedBehavior: ["The fixture changes schema parsing."],
            invariants: ["Structured review output remains valid."],
            evidence: ["src/example.ts:12"],
            limitations: ["This is a deterministic fixture."],
            noFindingRationale: "A validated fixture finding was returned."
          }
        }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });

    expect(JSON.parse(readFileSync(join(evidenceDir, "codex-usage.json"), "utf8"))).toEqual({
      model: "gpt-6.1-sol", reasoningEffort: "high", tokensUsed: null, durationMs: expect.any(Number)
    });
    expect(result.findings).toHaveLength(1);
    expect(result.droppedFromSchema).toEqual([]);
    expect(JSON.parse(readFileSync(join(evidenceDir, "codex-review-schema.json"), "utf8"))).toHaveProperty("properties.findings");

    const changedSnapshots = ["before", "after"];
    await expect(runCodexReview({
      cwd: join(root, "worktree"),
      prompt: "Return no findings.",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
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
    expect(JSON.parse(readFileSync(join(root, "changed-evidence", "codex-usage.json"), "utf8"))).toMatchObject({ tokensUsed: null });
  });

  it("records usage for verifier calls in the review evidence dir, beside the review's own usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-codex-verifier-usage-"));
    temporaryRoots.push(root);
    const reviewDir = join(root, "review-evidence");
    for (let call = 0; call < 2; call += 1) {
      await runCodexStructuredOutput({
        cwd: join(root, "worktree"), prompt: "verify", cliPath: "/Users/test/.local/bin/codex",
        model: "gpt-6.1-sol", reasoningEffort: "high", evidenceDir: join(root, `scratch-${call}`),
        timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, artifactPrefix: "severe-verifier",
        schema: { type: "object" }, parse: (value) => value, usageEvidenceDir: reviewDir
      }, {
        captureWorktreeState: () => "clean",
        runProcess: async (invocation) => {
          writeFileSync(invocation.outputPath, "{}");
          return { stdout: "", stderr: "model: gpt-6.1-sol\nreasoning effort: high\ntokens used\n12\u202f345\n", status: 0, signal: null };
        }
      });
    }
    const files = readdirSync(reviewDir).filter((name) => /^codex-usage-severe-verifier-[0-9a-f]{8}\.json$/.test(name));
    expect(files).toHaveLength(2);
    for (const name of files) {
      expect(JSON.parse(readFileSync(join(reviewDir, name), "utf8"))).toMatchObject({ model: "gpt-6.1-sol", tokensUsed: 12345 });
    }
  });

  it("supports a named strict structured result without weakening the read-only runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-codex-structured-"));
    temporaryRoots.push(root);
    const evidenceDir = join(root, "evidence");
    const result = await runCodexStructuredOutput({
      cwd: join(root, "worktree"),
      prompt: "Return the fixture classification.",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
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
    expect(existsSync(join(evidenceDir, "codex-issue-analysis-stdout.txt"))).toBe(true);
    expect(existsSync(join(evidenceDir, "codex-issue-analysis-stderr.txt"))).toBe(true);
  });

  it("rejects unsafe structured-output artifact prefixes before process execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-codex-prefix-"));
    temporaryRoots.push(root);
    let invoked = false;

    await expect(runCodexStructuredOutput({
      cwd: join(root, "worktree"),
      prompt: "unused",
      cliPath: "/Users/test/.local/bin/codex",
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
      evidenceDir: join(root, "evidence"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
      artifactPrefix: "../escaped",
      schema: {},
      parse: () => ({})
    }, {
      captureWorktreeState: () => "clean",
      runProcess: async () => {
        invoked = true;
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    })).rejects.toThrow("codex_runtime_invalid_artifact_prefix");

    expect(invoked).toBe(false);
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
      model: "gpt-6.1-sol",
      reasoningEffort: "high",
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
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        timeoutMs: 300_000,
        maxOutputBytes: 20 * 1024 * 1024,
        contextWindowTokens: 500_000
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
