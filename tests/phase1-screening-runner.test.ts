import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  runPhase1Screen,
  createLlamaServerExecutableAdapter,
  verifyPairedPhase1Cohort,
  type Phase1ResidentAdapter,
  type Phase1ResourceMonitor,
  type Phase1RunSpec
} from "../src/phase1-screening-runner.js";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

const ownershipProof = {
  ownershipVerifierSha256: "8".repeat(64),
  verifyListenerOwnership: async () => true,
  verifyProcessIdentity: async () => true
};
const runnerSourcePath = join(process.cwd(), "src", "phase1-screening-runner.ts");

function spec(outputDir: string): Phase1RunSpec {
  return {
    outputDir,
    safeOutputRoot: outputDir,
    checkoutRoot: process.cwd(),
    target: {
      id: "qwen36-27b-q4km",
      modelPath: "/models/qwen.gguf",
      modelSha256: "a".repeat(64),
      backendCommit: "6b4dc2116a92c5c8f2782bfe51fabe5ee66fb5ef",
      executable: "/opt/llama-server",
      executableSha256: "9".repeat(64),
      ownershipVerifierSha256: "8".repeat(64),
      args: ["--model", "/models/qwen.gguf", "--ctx-size", "8192"]
    },
    cells: [{ id: "warm-8k", contextTokens: 8192, repetition: 1 }],
    inputs: [
      { id: "pr-1", sha256: digest("Review PR one."), prompt: "Review PR one." },
      { id: "pr-2", sha256: digest("Review PR two."), prompt: "Review PR two." }
    ],
    prompt: { version: "phase1-prompt/v1", template: "{{input}}", templateSha256: digest("{{input}}") },
    request: {
      version: "phase1-request/v1",
      stream: false,
      outputBudgetTokens: 1024,
      requiredMetrics: [],
      parameters: { temperature: 0.6, top_p: 0.95, top_k: 20 }
    },
    harness: { commit: "1".repeat(40), sourcePath: runnerSourcePath, sourceSha256: digest(readFileSync(runnerSourcePath)) },
    parser: { version: "phase1-parser/v1", format: "json", sha256: digest("phase1-parser/v1:json") },
    gate: { version: "phase1-gate/v1", requiredTopLevelKeys: [], sha256: digest("phase1-gate/v1:") }
  };
}

function adapter(overrides: Partial<Phase1ResidentAdapter> = {}): Phase1ResidentAdapter {
  return {
    async start(context) {
      expect(existsSync(join(context.outputDir, "manifest.json"))).toBe(true);
      return { id: "resident-1", argv: ["/opt/llama-server", "--model", "/models/qwen.gguf"] };
    },
    async invoke(_resident, request) {
      return {
        status: "completed",
        rawOutput: JSON.stringify({ findings: [] }),
        parsedOutput: { findings: [] },
        metrics: { latencyMs: request.input.id === "pr-1" ? 10 : 20 }
      };
    },
    async stop() {},
    ...overrides
  };
}

describe("Phase 1 screening runner", () => {
  it("owns one resident executable lifecycle per cell and invokes its OpenAI-compatible endpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-executable-"));
    const port = 24000 + Math.floor(Math.random() * 10000);
    const script = join(root, "fake-llama-server.mjs");
    writeFileSync(script, `
      import http from "node:http";
      const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
      const server = http.createServer((req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
          const parsed = JSON.parse(body);
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ reviewed: parsed.messages[0].content }) } }], usage: { prompt_tokens: 12, completion_tokens: 3 }, timings: { prompt_ms: 20, predicted_ms: 10, predicted_per_second: 300 } }));
        });
      });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `);
    const runSpec = spec(join(root, "evidence"));
    const modelPath = join(root, "model.gguf");
    writeFileSync(modelPath, "test-model");
    runSpec.target.modelPath = modelPath;
    runSpec.target.modelSha256 = digest(readFileSync(modelPath));
    runSpec.target.executable = process.execPath;
    runSpec.target.executableSha256 = digest(readFileSync(process.execPath));
    runSpec.target.args = [script, "--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192"];
    const result = await runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }));
    expect(result.status).toBe("completed");
    const first = JSON.parse(readFileSync(join(runSpec.outputDir, "results", "warm-8k", "pr-1.json"), "utf8"));
    expect(first.parsedOutput).toEqual({ reviewed: "Review PR one." });
    expect(first.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(first.metrics.promptMs).toBe(20);
    expect(first.metrics.decodeTokensPerSecond).toBe(300);
  });

  it("captures TTFT from a bounded streaming response", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-stream-"));
    const port = 25000 + Math.floor(Math.random() * 8000);
    const script = join(root, "fake-stream-server.mjs");
    writeFileSync(script, `
      import http from "node:http";
      const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
      const server = http.createServer((req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        req.resume(); req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write("data: " + JSON.stringify({ choices: [{ delta: { content: '{"findings":' } }] }) + "\\n\\n");
          setTimeout(() => { res.write("data: " + JSON.stringify({ choices: [{ delta: { content: '[]}' } }] }) + "\\n\\n"); res.end('data: [DONE]\\n\\n'); }, 5);
        });
      });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `);
    const runSpec = spec(join(root, "evidence"));
    const modelPath = join(root, "model.gguf");
    writeFileSync(modelPath, "test-model");
    runSpec.target.modelPath = modelPath;
    runSpec.target.modelSha256 = digest(readFileSync(modelPath));
    runSpec.target.executable = process.execPath;
    runSpec.target.executableSha256 = digest(readFileSync(process.execPath));
    runSpec.target.args = [script, "--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192"];
    runSpec.request = { version: "phase1-request/v1", stream: true, outputBudgetTokens: 1024, requiredMetrics: ["latencyMs", "ttftMs"], parameters: { temperature: 0.6, top_p: 0.95, top_k: 20 } };
    const result = await runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      maxResponseBytes: 4096,
      ...ownershipProof
    }));
    expect(result.status).toBe("completed");
    const first = JSON.parse(readFileSync(join(runSpec.outputDir, "results", "warm-8k", "pr-1.json"), "utf8"));
    expect(first.metrics.ttftMs).toBeGreaterThanOrEqual(0);
    expect(first.parsedOutput).toEqual({ findings: [] });
  });

  it("constructs the prompt and applies manifest-bound request, parser, and gate contracts", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-contract-"));
    const runSpec = spec(outputDir);
    runSpec.prompt = {
      version: "phase1-prompt/v1",
      template: "PREFIX\n{{input}}\nSUFFIX",
      templateSha256: digest("PREFIX\n{{input}}\nSUFFIX")
    };
    runSpec.gate = {
      version: "phase1-gate/v1",
      requiredTopLevelKeys: ["findings"],
      sha256: digest("phase1-gate/v1:findings")
    };
    let observed: unknown;
    const result = await runPhase1Screen(runSpec, adapter({
      async invoke(_resident, request) {
        observed = { prompt: request.renderedPrompt, parameters: request.request.parameters };
        return { status: "completed", rawOutput: JSON.stringify({ findings: [] }) };
      }
    }));
    expect(result.status).toBe("completed");
    expect(observed).toEqual({
      prompt: "PREFIX\nReview PR two.\nSUFFIX",
      parameters: { temperature: 0.6, top_p: 0.95, top_k: 20 }
    });
    const first = JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8"));
    expect(first.parsedOutput).toEqual({ findings: [] });
    expect(first.gatedOutput).toEqual({ findings: [] });
    expect(first.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects runner-owned request keys and verifies the harness source bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-request-guard-"));
    for (const reserved of ["messages", "model", "stream", "response_format", "max_tokens"]) {
      const unsafe = spec(join(root, reserved));
      unsafe.request.parameters[reserved] = "override";
      await expect(runPhase1Screen(unsafe, adapter())).rejects.toThrow(/reserved request parameter/i);
    }
    const drift = spec(join(root, "harness-drift"));
    drift.harness.sourceSha256 = "0".repeat(64);
    await expect(runPhase1Screen(drift, adapter())).rejects.toThrow(/harness source sha/i);
  });

  it("turns parser and deterministic gate failures into explicit schema_failed terminals", async () => {
    const parserDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-parser-"));
    const parserResult = await runPhase1Screen(spec(parserDir), adapter({
      async invoke() { return { status: "completed", rawOutput: "not json" }; }
    }));
    expect(parserResult.counts.schema_failed).toBe(2);

    const gateDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-gate-"));
    const gateSpec = spec(gateDir);
    gateSpec.gate = {
      version: "phase1-gate/v1",
      requiredTopLevelKeys: ["findings"],
      sha256: digest("phase1-gate/v1:findings")
    };
    const gateResult = await runPhase1Screen(gateSpec, adapter({
      async invoke() { return { status: "completed", rawOutput: "{}" }; }
    }));
    expect(gateResult.counts.schema_failed).toBe(2);
  });

  it("rejects unsafe output placement and prompt/input identity drift before writing evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-safe-root-"));
    const outside = spec(join(root, "outside"));
    outside.safeOutputRoot = join(root, "allowed");
    await expect(runPhase1Screen(outside, adapter())).rejects.toThrow(/safe output root/i);
    expect(existsSync(outside.outputDir)).toBe(false);

    const insideCheckout = spec(join(process.cwd(), "runtime", "forbidden-phase1"));
    insideCheckout.safeOutputRoot = join(process.cwd(), "runtime");
    await expect(runPhase1Screen(insideCheckout, adapter())).rejects.toThrow(/outside.*checkout/i);

    const drift = spec(join(root, "drift"));
    drift.prompt.templateSha256 = "d".repeat(64);
    await expect(runPhase1Screen(drift, adapter())).rejects.toThrow(/template.*sha/i);
    const inputDrift = spec(join(root, "input-drift"));
    inputDrift.inputs[0].sha256 = "b".repeat(64);
    await expect(runPhase1Screen(inputDrift, adapter())).rejects.toThrow(/input.*sha/i);
  });

  it("verifies executable bytes before spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-binary-"));
    const runSpec = spec(join(root, "evidence"));
    runSpec.target.executable = process.execPath;
    runSpec.target.executableSha256 = "0".repeat(64);
    runSpec.target.args = ["--model", runSpec.target.modelPath, "--host", "127.0.0.1", "--port", "45111", "--ctx-size", "8192"];
    await expect(runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: "http://127.0.0.1:45111",
      readinessTimeoutMs: 10,
      ...ownershipProof
    }))).rejects.toThrow(/executable.*sha/i);
  });

  it("verifies model bytes and exact argv path before spawn", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-model-"));
    const modelPath = join(root, "model.gguf");
    writeFileSync(modelPath, "model-bytes");
    const runSpec = spec(join(root, "evidence"));
    runSpec.target.executable = process.execPath;
    runSpec.target.executableSha256 = digest(readFileSync(process.execPath));
    runSpec.target.modelPath = modelPath;
    runSpec.target.modelSha256 = "0".repeat(64);
    runSpec.target.args = ["--model", modelPath, "--host", "127.0.0.1", "--port", "45112", "--ctx-size", "8192"];
    await expect(runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: "http://127.0.0.1:45112",
      ...ownershipProof
    }))).rejects.toThrow(/model.*sha/i);

    runSpec.target.modelSha256 = digest(readFileSync(modelPath));
    runSpec.target.args = ["--model", join(root, "other.gguf"), "--host", "127.0.0.1", "--port", "45112", "--ctx-size", "8192"];
    await expect(runPhase1Screen({ ...runSpec, outputDir: join(root, "second"), safeOutputRoot: join(root, "second") }, createLlamaServerExecutableAdapter({
      baseUrl: "http://127.0.0.1:45112",
      ...ownershipProof
    }))).rejects.toThrow(/model path.*argv/i);
  });

  it("persists injected resource samples and converts monitor stop conditions to terminal states", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-"));
    let sequence = 0;
    const monitor: Phase1ResourceMonitor = {
      identity: { version: "test-monitor/v1", sha256: digest("test-monitor/v1") },
      async start() { return { id: "monitor-1" }; },
      async sample(_session, context) {
        sequence += 1;
        return { capturedAt: `sample-${sequence}`, phase: context.phase, rssBytes: 100 + sequence, vramBytes: 200, swapBytes: sequence > 2 ? 4096 : 0 };
      },
      classify(samples) {
        return samples.some((sample) => sample.swapBytes >= 4096)
          ? { status: "stopped", errorCode: "sustained_swap_growth" }
          : undefined;
      },
      async stop(_session) { return { capturedAt: "stop", phase: "stopped", rssBytes: 0, vramBytes: 0, swapBytes: 0 }; }
    };
    const result = await runPhase1Screen(spec(outputDir), adapter(), { monitor });
    expect(result.counts.stopped).toBeGreaterThan(0);
    const resource = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resource.samples.at(-1).phase).toBe("stopped");
    expect(resource.monitorFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["before", "after", "classify"] as const)("treats monitor %s exceptions as infrastructure failures", async (stage) => {
    const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-monitor-${stage}-`));
    const monitor: Phase1ResourceMonitor = {
      identity: { version: "throw-monitor/v1", sha256: digest("throw-monitor/v1") },
      async start() { return { id: "throw-monitor" }; },
      async sample(_session, context) {
        if (context.phase === stage) throw new Error(`monitor ${stage} exploded`);
        return { capturedAt: context.phase, phase: context.phase, rssBytes: 1, vramBytes: 1, swapBytes: 0 };
      },
      classify() { if (stage === "classify") throw new Error("monitor classify exploded"); return undefined; },
      async stop() { return { capturedAt: "stop", phase: "stopped", rssBytes: 0, vramBytes: 0, swapBytes: 0 }; }
    };
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitor })).rejects.toThrow(/monitor.*exploded/i);
    const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
    expect(summary.infrastructureErrorCode).toContain("monitor_");
  });

  it("stops and persists monitor evidence when resident startup fails", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-start-fail-"));
    let stopped = 0;
    const monitor: Phase1ResourceMonitor = {
      identity: { version: "start-monitor/v1", sha256: digest("start-monitor/v1") },
      async start() { return { id: "monitor" }; },
      async sample() { throw new Error("must not sample"); },
      async stop() { stopped += 1; return { capturedAt: "stop", phase: "stopped", rssBytes: 0, vramBytes: 0, swapBytes: 0 }; }
    };
    await expect(runPhase1Screen(spec(outputDir), adapter({ async start() { throw new Error("resident startup failed"); } }), { monitor })).rejects.toThrow(/resident startup failed/i);
    expect(stopped).toBe(1);
    expect(existsSync(join(outputDir, "resources", "warm-8k.json"))).toBe(true);
  });

  it("records valid empty resource evidence when the monitor itself cannot start", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-start-error-"));
    const monitor: Phase1ResourceMonitor = {
      identity: { version: "start-error-monitor/v1", sha256: digest("start-error-monitor/v1") },
      async start() { throw new Error("monitor start exploded"); },
      async sample() { throw new Error("must not sample"); },
      async stop() { throw new Error("must not stop an unavailable session"); }
    };
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitor })).rejects.toThrow(/monitor start exploded/i);
    const resource = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resource.samples).toEqual([]);
    expect(resource.terminalInfrastructureErrorCode).toBe("monitor_start_exploded");
    expect(resource.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("continues after an isolated request failure and records retry counts", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-request-failure-"));
    let calls = 0;
    const result = await runPhase1Screen(spec(outputDir), adapter({
      async invoke() {
        calls += 1;
        return calls === 1
          ? { status: "failed", errorCode: "http_503", retryCount: 2 }
          : { status: "completed", rawOutput: "{}", retryCount: 0 };
      }
    }));
    expect(calls).toBe(2);
    expect(result.counts.failed).toBe(1);
    expect(result.counts.completed).toBe(1);
    expect(JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8")).retryCount).toBe(2);
  });

  it("rejects non-loopback or target-mismatched executable endpoints before spawning", () => {
    expect(() => createLlamaServerExecutableAdapter({ baseUrl: "https://provider.example.com" })).toThrow(/loopback/i);
    const runSpec = spec(mkdtempSync(join(tmpdir(), "neondiff-phase1-endpoint-")));
    runSpec.target.args = ["--host", "127.0.0.1", "--port", "45001"];
    return expect(runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: "http://127.0.0.1:45002",
      readinessTimeoutMs: 10,
      ...ownershipProof
    }))).rejects.toThrow(/must match.*target argv/i);
  });

  it("refuses a pre-existing loopback listener rather than sending it a screening prompt", async () => {
    const port = 34000 + Math.floor(Math.random() * 10000);
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200);
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const runSpec = spec(mkdtempSync(join(tmpdir(), "neondiff-phase1-owned-port-")));
      const modelPath = join(runSpec.outputDir, "model.gguf");
      writeFileSync(modelPath, "test-model");
      runSpec.target.executable = process.execPath;
      runSpec.target.executableSha256 = digest(readFileSync(process.execPath));
      runSpec.target.modelPath = modelPath;
      runSpec.target.modelSha256 = digest(readFileSync(modelPath));
      runSpec.target.args = ["-e", "setTimeout(() => {}, 10000)", "--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192"];
      await expect(runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
        baseUrl: `http://127.0.0.1:${port}`,
        readinessTimeoutMs: 500,
        ...ownershipProof
      }))).rejects.toThrow(/already.*listener|already.*use/i);
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("persists the immutable manifest before execution and writes atomic terminal results and summary", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-"));
    const result = await runPhase1Screen(spec(outputDir), adapter());

    expect(result.status).toBe("completed");
    expect(result.counts).toEqual({ completed: 2, failed: 0, stopped: 0, oom: 0, schema_failed: 0 });
    expect(existsSync(join(outputDir, "results", "warm-8k", "pr-1.json"))).toBe(true);
    expect(existsSync(join(outputDir, "results", "warm-8k", "pr-2.json"))).toBe(true);
    expect(existsSync(join(outputDir, "summary.json"))).toBe(true);
    expect(existsSync(join(outputDir, "COMPLETED"))).toBe(true);
    expect(existsSync(join(outputDir, "RUNNING"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: "neondiff-phase1-screen-manifest/v1",
      targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      parserFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      gateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(manifest.cells[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.inputs[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.harnessFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.claimClass).toBe("transport_and_gate_only");
    expect(existsSync(join(outputDir, "results", "warm-8k", "pr-1.json.tmp"))).toBe(false);
  });

  it("holds an exclusive output lease and rejects a concurrent writer", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-lease-"));
    writeFileSync(join(outputDir, ".phase1-run.lock"), JSON.stringify({ pid: process.pid }));
    await expect(runPhase1Screen(spec(outputDir), adapter())).rejects.toThrow(/active exclusive run lease/i);
  });

  it("verifies paired cohort identity and rejects request or input drift", async () => {
    const leftDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-pair-left-"));
    const rightDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-pair-right-"));
    await runPhase1Screen(spec(leftDir), adapter());
    await runPhase1Screen(spec(rightDir), adapter());
    expect(verifyPairedPhase1Cohort(join(leftDir, "manifest.json"), join(rightDir, "manifest.json"))).toMatchObject({ ok: true });

    const rightManifestPath = join(rightDir, "manifest.json");
    const right = JSON.parse(readFileSync(rightManifestPath, "utf8"));
    right.request.outputBudgetTokens += 1;
    writeFileSync(rightManifestPath, JSON.stringify(right));
    expect(() => verifyPairedPhase1Cohort(join(leftDir, "manifest.json"), rightManifestPath)).toThrow(/paired cohort drift.*request/i);
  });

  it("resumes only an exact manifest and never re-runs an existing terminal result", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-resume-"));
    let calls = 0;
    let starts = 0;
    const counting = adapter({
      async start(context) {
        starts += 1;
        return adapter().start(context);
      },
      async invoke(resident, request) {
        calls += 1;
        return adapter().invoke(resident, request);
      }
    });
    await runPhase1Screen(spec(outputDir), counting);
    await runPhase1Screen(spec(outputDir), counting);
    expect(calls).toBe(2);
    expect(starts).toBe(1);

    const changed = spec(outputDir);
    changed.gate = { ...changed.gate, version: "phase1-gate/v2", sha256: digest("phase1-gate/v2:") };
    await expect(runPhase1Screen(changed, counting)).rejects.toThrow(/manifest fingerprint mismatch/i);
  });

  it("reconciles summary and terminal markers after a crash following the last atomic result", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-reconcile-"));
    await runPhase1Screen(spec(outputDir), adapter());
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));
    writeFileSync(join(outputDir, "RUNNING"), "interrupted\n");
    const resumed = await runPhase1Screen(spec(outputDir), adapter({
      async start() { throw new Error("must not restart resident"); }
    }));
    expect(resumed.status).toBe("completed");
    expect(existsSync(join(outputDir, "summary.json"))).toBe(true);
    expect(existsSync(join(outputDir, "COMPLETED"))).toBe(true);
    expect(existsSync(join(outputDir, "RUNNING"))).toBe(false);
  });

  it("rejects a tampered terminal result before starting a resident or changing terminal markers", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-tamper-"));
    await runPhase1Screen(spec(outputDir), adapter());
    const resultPath = join(outputDir, "results", "warm-8k", "pr-1.json");
    const result = JSON.parse(readFileSync(resultPath, "utf8"));
    result.rawOutput = "tampered but fingerprint fields retained";
    writeFileSync(resultPath, JSON.stringify(result));
    let starts = 0;
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async start(context) {
        starts += 1;
        return adapter().start(context);
      }
    }))).rejects.toThrow(/terminal result fingerprint mismatch/i);
    expect(starts).toBe(0);
    expect(existsSync(join(outputDir, "COMPLETED"))).toBe(true);
    expect(existsSync(join(outputDir, "RUNNING"))).toBe(false);
  });

  it("rejects tampering with every persisted immutable result identity", async () => {
    for (const field of ["targetFingerprint", "promptFingerprint", "parserFingerprint", "gateFingerprint", "requestFingerprint", "harnessFingerprint", "cellId", "inputId", "startedAt", "completedAt"]) {
      const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-identity-${field}-`));
      await runPhase1Screen(spec(outputDir), adapter());
      const resultPath = join(outputDir, "results", "warm-8k", "pr-1.json");
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      result[field] = "tampered";
      writeFileSync(resultPath, JSON.stringify(result));
      await expect(runPhase1Screen(spec(outputDir), adapter())).rejects.toThrow(/terminal result fingerprint mismatch/i);
    }
  });

  it.each(["failed", "stopped", "oom", "schema_failed"] as const)(
    "records %s as an explicit terminal state without silently dropping a PR",
    async (status) => {
      const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-${status}-`));
      const result = await runPhase1Screen(spec(outputDir), adapter({
        async invoke(_resident, request) {
          return request.input.id === "pr-1"
            ? { status, errorCode: `test_${status}` }
            : { status: "completed", rawOutput: "{}", parsedOutput: {} };
        }
      }));
      expect(result.status).toBe("failed");
      // A request terminal is not proof that the resident died. Only an
      // explicit residentTerminal result (or the runner's own process/monitor
      // evidence) may truncate the remainder of the cell.
      expect(result.counts[status]).toBe(1);
      expect(result.counts.completed).toBe(1);
      expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
      expect(JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8"))).toMatchObject({ status });
    }
  );

  it.each(["failed", "stopped", "oom"] as const)(
    "truncates a cell only when %s carries explicit resident-terminal evidence",
    async (status) => {
      const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-resident-terminal-${status}-`));
      let calls = 0;
      const result = await runPhase1Screen(spec(outputDir), adapter({
        async invoke() {
          calls += 1;
          return { status, errorCode: `resident_${status}`, residentTerminal: true };
        }
      }));
      expect(calls).toBe(1);
      expect(result.counts[status]).toBe(2);
      expect(result.counts.completed).toBe(0);
    }
  );

  it("fails closed before execution when target argv or adapter logs contain secret-like text", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-secret-"));
    const unsafe = spec(outputDir);
    unsafe.target.args.push("--api-key", "sk-secret-value-1234567890");
    await expect(runPhase1Screen(unsafe, adapter())).rejects.toThrow(/secret-like text/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);

    const unsafeParameters = spec(mkdtempSync(join(tmpdir(), "neondiff-phase1-secret-parameters-")));
    unsafeParameters.target.servingParameters = { apiKey: "sk-secret-value-1234567890" };
    await expect(runPhase1Screen(unsafeParameters, adapter())).rejects.toThrow(/secret-like text/i);
    expect(existsSync(join(unsafeParameters.outputDir, "manifest.json"))).toBe(false);

    const second = spec(mkdtempSync(join(tmpdir(), "neondiff-phase1-secret-log-")));
    await expect(runPhase1Screen(second, adapter({
      async start() {
        return { id: "resident", argv: ["/opt/llama-server"], logs: "Authorization: Bearer sk-secret-value-1234567890" };
      }
    }))).rejects.toThrow(/secret-like text/i);
    expect(readFileSync(join(second.outputDir, "summary.json"), "utf8")).not.toContain("sk-secret");
  });

  it("converts thrown invocation errors to failed terminal records and still stops the resident", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-throw-"));
    let stopped = false;
    const result = await runPhase1Screen(spec(outputDir), adapter({
      async invoke(_resident, request) {
        if (request.input.id === "pr-1") throw new Error("inference crashed");
        return { status: "completed", rawOutput: "{}", parsedOutput: {} };
      },
      async stop() { stopped = true; }
    }));
    expect(stopped).toBe(true);
    expect(result.counts.failed).toBe(1);
    expect(result.counts.completed).toBe(1);
  });

  it("durably records a redacted infrastructure failure code when resident shutdown fails", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-stop-failure-"));
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async stop() { throw new Error("shutdown failed"); }
    }))).rejects.toThrow(/shutdown failed/i);
    const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
    expect(summary.status).toBe("failed");
    expect(summary.infrastructureErrorCode).toBe("shutdown_failed");
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
    const resumed = await runPhase1Screen(spec(outputDir), adapter({
      async start() { throw new Error("must not restart resident"); }
    }));
    expect(resumed.status).toBe("failed");
    expect(resumed.infrastructureErrorCode).toBe("shutdown_failed");
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
    expect(existsSync(join(outputDir, "COMPLETED"))).toBe(false);
  });
});
