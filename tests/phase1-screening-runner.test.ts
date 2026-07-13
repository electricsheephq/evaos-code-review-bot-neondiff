import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  runPhase1Screen as executePhase1Screen,
  createLlamaServerExecutableAdapter,
  phase1ScreeningRunnerModulePath,
  phase1LeaseCoordinationPort,
  verifyPairedPhase1Cohort,
  type Phase1ResidentAdapter,
  type Phase1ResourceMonitorModule,
  type Phase1RunSpec
} from "../src/phase1-screening-runner.js";
import { llamaCppPlacementAttestationModulePath } from "../src/llama-cpp-placement-attestation.js";

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function evidenceDigest(value: unknown): string {
  return digest(canonical(value));
}

function fullPlacementFixture(): string[] {
  return [
    "load_tensors: layer 0 assigned to device CUDA0, is_swa = 0",
    "load_tensors: layer 1 assigned to device CUDA0, is_swa = 0",
    "load_tensors: layer 2 assigned to device CUDA0, is_swa = 0",
    "load_tensors: offloading output layer to GPU",
    "load_tensors: offloading 2 repeating layers to GPU",
    "load_tensors: offloaded 3/3 layers to GPU",
    "load_tensors: CPU_Mapped model buffer size = 128.00 MiB",
    "load_tensors: CUDA0 model buffer size = 2048.00 MiB",
    "llama_kv_cache_unified: CUDA0 KV buffer size = 256.00 MiB",
    "llama_kv_cache_unified: size = 256.00 MiB (4096 cells, 3 layers, 1/1 seqs), K (f16): 128.00 MiB, V (f16): 128.00 MiB",
    "llama_context: CUDA0 output buffer size = 4.00 MiB",
    "sched_reserve: CUDA0 compute buffer size = 64.00 MiB"
  ];
}

function cpuMoePlacementFixture(): string[] {
  return [
    ...fullPlacementFixture(),
    ...[0, 1].flatMap((layer) => ["gate", "up", "down"].map((kind) =>
      `tensor blk.${layer}.ffn_${kind}_exps.weight (512 MiB q4_K) buffer type overridden to CPU`
    ))
  ];
}

const ownershipProof = {
  ownershipVerifierSha256: "8".repeat(64),
  verifyListenerOwnership: async () => true,
  verifyProcessIdentity: async () => true
};
const runnerSourcePath = join(process.cwd(), "src", "phase1-screening-runner.ts");
const harnessRepo = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-phase1-harness-repo-")));
const harnessRepoSource = join(harnessRepo, "src", "phase1-screening-runner.ts");
const harnessEntrypoint = join(harnessRepo, "dist", "src", "phase1-characterization-cli.js");
const harnessRunner = realpathSync(phase1ScreeningRunnerModulePath());
mkdirSync(dirname(harnessRepoSource), { recursive: true });
mkdirSync(dirname(harnessEntrypoint), { recursive: true });
writeFileSync(harnessRepoSource, readFileSync(runnerSourcePath));
writeFileSync(harnessEntrypoint, "export const entrypoint = true;\n");
execFileSync("git", ["init", "-q", harnessRepo]);
execFileSync("git", ["-C", harnessRepo, "config", "user.email", "phase1@example.invalid"]);
execFileSync("git", ["-C", harnessRepo, "config", "user.name", "Phase 1 Test"]);
execFileSync("git", ["-C", harnessRepo, "add", "src/phase1-screening-runner.ts"]);
execFileSync("git", ["-C", harnessRepo, "commit", "-qm", "pin harness"]);
const harnessCommit = execFileSync("git", ["-C", harnessRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

const monitorModuleRoot = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-modules-"));
let monitorModuleSequence = 0;
function monitorModule(kind: string): Phase1ResourceMonitorModule {
  const modulePath = join(monitorModuleRoot, `monitor-${monitorModuleSequence++}.mjs`);
  writeFileSync(modulePath, `
    const kind = ${JSON.stringify(kind)};
    let sequence = 0;
    let attachObserved = false;
    let forceStopOom = false;
    let attemptTag = "none";
    export function createMonitor(factoryParameters) {
      if (kind === "factory-parameters" && (!Object.isFrozen(factoryParameters) || factoryParameters?.nvidiaSmiSha256 !== ${JSON.stringify("a".repeat(64))})) {
        throw new Error("factory parameters were not immutably bound");
      }
      return {
        async start() {
          if (kind === "start-error") throw new Error("monitor start exploded");
          if (kind === "start-null") return null;
          if (kind === "start-undefined") return undefined;
          if (kind === "start-empty") return {};
          return { id: "monitor" };
        },
        async attach(_session, resident) {
          if (kind === "attach-error") throw new Error("monitor attach exploded");
          if (kind === "conditional-attach-error" && resident.metadata?.failAttach) throw new Error("monitor attach exploded");
          if (kind === "attach-and-stop-error") throw new Error("monitor attach exploded");
          if (kind === "attach-unsafe-probe") attachObserved = true;
          if (kind === "conditional-stop-oom") forceStopOom = resident.metadata?.forceStopOom === true;
          if (kind === "attempt-tagged") attemptTag = resident.metadata?.attemptTag ?? "none";
          if (!resident.metadata || resident.metadata.pid !== 42) throw new Error("monitor did not receive resident metadata");
        },
        async sample(_session, context) {
          if (kind === "throw-" + context.phase) throw new Error("monitor " + context.phase + " exploded");
          sequence += 1;
          const base = { capturedAt: "sample-" + sequence, phase: context.phase, rssBytes: 100 + sequence, vramBytes: 200, swapBytes: kind === "swap" && sequence > 2 ? 4096 : 0, factoryParametersBound: kind === "factory-parameters" ? 1 : 0, attemptTag };
          if (kind === "sample-nan") return { ...base, rssBytes: Number.NaN };
          if (kind === "sample-infinity") return { ...base, diagnosticValue: Number.POSITIVE_INFINITY };
          if (kind === "sample-negative") return { ...base, vramBytes: -1 };
          return base;
        },
        classify(samples) {
          if (kind === "throw-classify") throw new Error("monitor classify exploded");
          if (kind === "classify-invalid-status") return { status: "completed", errorCode: "invalid" };
          if (kind === "classify-missing-code") return { status: "stopped" };
          if (kind === "classify-scalar") return "stopped";
          if (kind === "attempt-tagged" && samples.some(sample => sample.attemptTag === "old") && samples.some(sample => sample.attemptTag === "current")) return { status: "stopped", errorCode: "stale_attempt_included" };
          if (kind === "swap" && samples.some(sample => sample.swapBytes >= 4096)) return { status: "stopped", errorCode: "sustained_swap_growth" };
          if (kind === "stop-oom" && samples.some(sample => sample.phase === "stopped")) return { status: "oom", errorCode: "stop_time_oom" };
          if (kind === "conditional-stop-oom" && forceStopOom && samples.some(sample => sample.phase === "stopped")) return { status: "oom", errorCode: "stop_time_oom" };
          return undefined;
        },
        async stop() {
          const base = { capturedAt: "stop", phase: "stopped", rssBytes: 0, vramBytes: 0, swapBytes: 0, attachObserved: attachObserved ? 1 : 0, attemptTag };
          if (kind === "attach-and-stop-error") throw new Error("monitor stop exploded");
          if (kind === "stop-empty") return [];
          if (kind === "stop-array") return [{ ...base, capturedAt: "periodic", phase: "periodic" }, base];
          if (kind === "secret-stop") return { ...base, diagnostic: "Authorization: Bearer sk-secret-value-1234567890" };
          if (kind === "secret-fingerprint-stop") return { ...base, evidenceSha256: "sk-secret-value-1234567890" };
          if (kind === "stop-nan") return { ...base, swapBytes: Number.NaN };
          return base;
        }
      };
    }
  `);
  return {
    version: `test-monitor/${kind}/v1`,
    modulePath,
    moduleSha256: digest(readFileSync(modulePath)),
    approvedRoot: monitorModuleRoot,
    exportName: "createMonitor",
    ...(kind === "factory-parameters" ? { factoryParameters: { nvidiaSmiSha256: "a".repeat(64) } } : {})
  };
}

const runPhase1Screen = executePhase1Screen;

function spec(outputDir: string): Phase1RunSpec {
  return {
    outputDir,
    safeOutputRoot: outputDir,
    checkoutRoot: harnessRepo,
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
    harness: {
      commit: harnessCommit,
      sourcePath: harnessRepoSource,
      sourceSha256: digest(readFileSync(harnessRepoSource)),
      entrypointPath: harnessEntrypoint,
      entrypointSha256: digest(readFileSync(harnessEntrypoint)),
      runnerPath: harnessRunner,
      runnerSha256: digest(readFileSync(harnessRunner))
    },
    parser: { version: "phase1-parser/v1", format: "json", sha256: digest("phase1-parser/v1:json") },
    gate: { version: "phase1-gate/v1", requiredTopLevelKeys: [], sha256: digest("phase1-gate/v1:") }
  };
}

function adapter(overrides: Partial<Phase1ResidentAdapter> = {}): Phase1ResidentAdapter {
  return {
    async start(context) {
      expect(existsSync(join(context.outputDir, "manifest.json"))).toBe(true);
      return { id: "resident-1", argv: ["/opt/llama-server", "--model", "/models/qwen.gguf"], metadata: { pid: 42 } };
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
    let freshIdentityChecks = 0;
    const result = await runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof,
      async verifyProcessIdentity() { freshIdentityChecks += 1; return true; }
    }));
    expect(result.status).toBe("completed");
    const first = JSON.parse(readFileSync(join(runSpec.outputDir, "results", "warm-8k", "pr-1.json"), "utf8"));
    expect(first.parsedOutput).toEqual({ reviewed: "Review PR one." });
    expect(first.metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(first.metrics.promptMs).toBe(20);
    expect(first.metrics.decodeTokensPerSecond).toBe(300);
    expect(freshIdentityChecks).toBeGreaterThanOrEqual(1);

    const rejectedSpec = { ...runSpec, outputDir: join(root, "identity-rejected"), safeOutputRoot: join(root, "identity-rejected") };
    await expect(runPhase1Screen(rejectedSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof,
      async verifyProcessIdentity() { return false; }
    }))).rejects.toThrow(/process identity could not be proven/i);
    const probe = createNetServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      probe.once("error", rejectPromise);
      probe.listen(port, "127.0.0.1", resolvePromise);
    });
    await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  });

  it("persists immutable placement evidence before invoking an explicit offload-comparison cell", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-placement-"));
    const port = 24000 + Math.floor(Math.random() * 10000);
    const script = join(root, "fake-placement-server.mjs");
    writeFileSync(script, `
      import http from "node:http";
      const verbosityIndex = Math.max(process.argv.lastIndexOf("-lv"), process.argv.lastIndexOf("--verbosity"), process.argv.lastIndexOf("--log-verbosity"));
      const debugEnabled = process.argv.some((arg) => ["-v", "--verbose", "--log-verbose"].includes(arg)) || (verbosityIndex >= 0 && Number(process.argv[verbosityIndex + 1]) >= 5);
      if (debugEnabled) for (const line of ${JSON.stringify(fullPlacementFixture())}) process.stderr.write(line + "\\n");
      const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
      const server = http.createServer((req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        req.resume(); req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
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
    runSpec.target.args = [script, "--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192", "-ngl", "999", "-lv", "5"];
    const placementModulePath = realpathSync(llamaCppPlacementAttestationModulePath());
    runSpec.cells[0].placement = {
      mode: "offload_comparison",
      profile: "full_gpu",
      requestedGpuLayers: 999,
      parserVersion: "llama.cpp-b9977-placement/v2",
      parserSourcePath: placementModulePath,
      parserSourceSha256: digest(readFileSync(placementModulePath)),
      maxStartupBytes: 16_384,
      maxStartupLines: 128
    };

    const noDebugSpec = structuredClone(runSpec);
    noDebugSpec.outputDir = join(root, "no-debug");
    noDebugSpec.safeOutputRoot = noDebugSpec.outputDir;
    noDebugSpec.target.args = noDebugSpec.target.args.filter((arg) => arg !== "-lv" && arg !== "5");
    await expect(runPhase1Screen(noDebugSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }))).rejects.toThrow(/debug-enabling verbosity/i);

    const summary = await runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }));

    expect(summary.status).toBe("completed");
    const placementPath = join(runSpec.outputDir, "placements", "warm-8k", "placement.json");
    const sourcePath = join(runSpec.outputDir, "placements", "warm-8k", "startup-source.json");
    expect(existsSync(placementPath)).toBe(true);
    expect(existsSync(sourcePath)).toBe(true);
    const placement = JSON.parse(readFileSync(placementPath, "utf8"));
    expect(placement).toMatchObject({
      schemaVersion: "neondiff-phase1-placement/v1",
      runFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      cellId: "warm-8k",
      observed: { observedGpuLayers: 3 }
    });
    expect(placement.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);

    const startPath = join(runSpec.outputDir, placement.identity.processStartReceiptRelativePath);
    const start = JSON.parse(readFileSync(startPath, "utf8"));
    start.targetId = "tampered-target";
    writeFileSync(startPath, `${JSON.stringify(start, null, 2)}\n`);
    await expect(runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }))).rejects.toThrow(/process attestation mismatch/i);
    start.targetId = runSpec.target.id;
    writeFileSync(startPath, `${JSON.stringify(start, null, 2)}\n`);

    placement.observed.observedGpuLayers = 2;
    writeFileSync(placementPath, `${JSON.stringify(placement, null, 2)}\n`);
    await expect(runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }))).rejects.toThrow(/placement evidence fingerprint mismatch/i);
  });

  it("fails closed and cleans up when an offload-comparison adapter omits placement evidence", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-placement-missing-"));
    const runSpec = spec(outputDir);
    const placementModulePath = realpathSync(llamaCppPlacementAttestationModulePath());
    runSpec.cells[0].placement = {
      mode: "offload_comparison",
      profile: "full_gpu",
      requestedGpuLayers: 3,
      parserVersion: "llama.cpp-b9977-placement/v2",
      parserSourcePath: placementModulePath,
      parserSourceSha256: digest(readFileSync(placementModulePath)),
      maxStartupBytes: 16_384,
      maxStartupLines: 128
    };
    let stopped = false;

    await expect(runPhase1Screen(runSpec, adapter({
      async stop() { stopped = true; }
    }))).rejects.toThrow(/required placement evidence is missing/i);

    expect(stopped).toBe(true);
    expect(existsSync(join(outputDir, "placements", "warm-8k", "placement.json"))).toBe(false);
    expect(existsSync(join(outputDir, "placements", "warm-8k", "startup-source.json"))).toBe(false);
    const first = JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8"));
    expect(first.status).toBe("failed");
    expect(first.invocationDisposition).toBe("not_invoked_infrastructure");

    const resumed = await runPhase1Screen(runSpec, adapter({
      async start() { throw new Error("resume must not start a resident"); }
    }));
    expect(resumed.status).toBe("failed");
  });

  it("rejects an all-layers request for a partial-GPU policy before resident startup", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-partial-all-"));
    const runSpec = spec(outputDir);
    const placementModulePath = realpathSync(llamaCppPlacementAttestationModulePath());
    runSpec.cells[0].placement = {
      mode: "offload_comparison",
      profile: "partial_gpu",
      requestedGpuLayers: "all",
      parserVersion: "llama.cpp-b9977-placement/v2",
      parserSourcePath: placementModulePath,
      parserSourceSha256: digest(readFileSync(placementModulePath)),
      maxStartupBytes: 16_384,
      maxStartupLines: 128
    };
    let starts = 0;

    await expect(runPhase1Screen(runSpec, adapter({
      async start() {
        starts += 1;
        return { id: "resident", argv: ["/opt/llama-server"] };
      }
    }))).rejects.toThrow(/partial-GPU.*finite.*layer request/i);
    expect(starts).toBe(0);
  });

  it("persists explicit CPU-MoE expert placement from the pinned b9977 debug grammar", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-placement-cpu-moe-"));
    const port = 24000 + Math.floor(Math.random() * 10000);
    const script = join(root, "fake-cpu-moe-server.mjs");
    writeFileSync(script, `
      import http from "node:http";
      const verbosityIndex = Math.max(process.argv.lastIndexOf("-lv"), process.argv.lastIndexOf("--verbosity"), process.argv.lastIndexOf("--log-verbosity"));
      const debugEnabled = process.argv.some((arg) => ["-v", "--verbose", "--log-verbose"].includes(arg)) || (verbosityIndex >= 0 && Number(process.argv[verbosityIndex + 1]) >= 5);
      if (debugEnabled) for (const line of ${JSON.stringify(cpuMoePlacementFixture())}) process.stderr.write(line + "\\n");
      const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
      const server = http.createServer((req, res) => {
        if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
        req.resume(); req.on("end", () => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
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
    runSpec.target.args = [script, "--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192", "-ngl", "999", "--n-cpu-moe", "2", "-lv", "5"];
    const placementModulePath = realpathSync(llamaCppPlacementAttestationModulePath());
    runSpec.cells[0].placement = {
      mode: "offload_comparison",
      profile: "all_plus_cpu_moe",
      requestedGpuLayers: 999,
      expectedCpuMoe: { requestKind: "first_n", firstLayer: 0, lastLayer: 1, layerCount: 2, minimumMatchedTensors: 6 },
      parserVersion: "llama.cpp-b9977-placement/v2",
      parserSourcePath: placementModulePath,
      parserSourceSha256: digest(readFileSync(placementModulePath)),
      maxStartupBytes: 32_768,
      maxStartupLines: 256
    };

    const conflictingSpec = structuredClone(runSpec);
    conflictingSpec.outputDir = join(root, "conflicting-cpu-moe");
    conflictingSpec.safeOutputRoot = conflictingSpec.outputDir;
    conflictingSpec.target.args.push("--cpu-moe");
    await expect(runPhase1Screen(conflictingSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }))).rejects.toThrow(/CPU-MoE arguments conflict or are duplicated/i);

    const summary = await runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }));
    expect(summary.status).toBe("completed");
    const placement = JSON.parse(readFileSync(join(runSpec.outputDir, "placements", "warm-8k", "placement.json"), "utf8"));
    expect(placement.observed.cpuExpertOverrides).toMatchObject({
      device: "CPU",
      affectedLayerCount: 2,
      matchedTensorCount: 6
    });

    const allExpertsSpec = structuredClone(runSpec);
    allExpertsSpec.outputDir = join(root, "all-experts");
    allExpertsSpec.safeOutputRoot = allExpertsSpec.outputDir;
    allExpertsSpec.target.args = allExpertsSpec.target.args.flatMap((argument, index, arguments_) =>
      argument === "--n-cpu-moe" ? ["--cpu-moe"] : arguments_[index - 1] === "--n-cpu-moe" ? [] : [argument]
    );
    allExpertsSpec.cells[0].placement!.expectedCpuMoe!.requestKind = "all";
    const allExpertsSummary = await runPhase1Screen(allExpertsSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 2_000,
      ...ownershipProof
    }));
    expect(allExpertsSummary.status).toBe("completed");
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
          setTimeout(() => { res.write("data: " + JSON.stringify({ choices: [{ delta: { content: '[]}' } }], usage: { prompt_tokens: 120, completion_tokens: 7, total_tokens: 127 }, timings: { prompt_ms: 40, predicted_ms: 20, prompt_per_second: 3000, predicted_per_second: 350 } }) + "\\n\\n"); res.end('data: [DONE]\\n\\n'); }, 5);
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
    expect(first.metrics.promptTokens).toBe(120);
    expect(first.metrics.completionTokens).toBe(7);
    expect(first.metrics.totalTokens).toBe(127);
    expect(first.metrics.promptMs).toBe(40);
    expect(first.metrics.decodeMs).toBe(20);
    expect(first.metrics.promptTokensPerSecond).toBe(3000);
    expect(first.metrics.decodeTokensPerSecond).toBe(350);
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

    const wrongCommit = spec(join(root, "wrong-commit"));
    wrongCommit.harness.commit = "2".repeat(40);
    await expect(runPhase1Screen(wrongCommit, adapter())).rejects.toThrow(/declared commit/i);

    const outsideSource = join(root, "copied-runner.ts");
    writeFileSync(outsideSource, readFileSync(runnerSourcePath));
    const outside = spec(join(root, "outside-checkout"));
    outside.harness.sourcePath = outsideSource;
    outside.harness.sourceSha256 = digest(readFileSync(outsideSource));
    await expect(runPhase1Screen(outside, adapter())).rejects.toThrow(/inside checkoutRoot/i);
  });

  it("verifies declared entrypoint and runner bytes before manifest persistence or adapter startup", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "neondiff-phase1-loaded-artifacts-")));
    for (const artifact of ["entrypoint", "runner"] as const) {
      const outputDir = join(root, artifact);
      const runSpec = spec(outputDir);
      const path = join(root, `${artifact}.js`);
      writeFileSync(path, `export const ${artifact} = true;\n`);
      runSpec.harness[`${artifact}Path`] = path;
      runSpec.harness[`${artifact}Sha256`] = "0".repeat(64);
      let starts = 0;
      await expect(runPhase1Screen(runSpec, adapter({
        async start() { starts += 1; return { id: "resident", argv: ["/opt/llama-server"], metadata: { pid: 42 } }; }
      }))).rejects.toThrow(new RegExp(`${artifact} SHA-256`, "i"));
      expect(starts).toBe(0);
      expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
    }

    const outputDir = join(root, "unrelated-runner");
    const runSpec = spec(outputDir);
    const unrelatedRunner = join(root, "unrelated-runner.js");
    writeFileSync(unrelatedRunner, "export const runner = true;\n");
    runSpec.harness.runnerPath = unrelatedRunner;
    runSpec.harness.runnerSha256 = digest(readFileSync(unrelatedRunner));
    let starts = 0;
    await expect(runPhase1Screen(runSpec, adapter({
      async start() { starts += 1; return { id: "resident", argv: ["/opt/llama-server"], metadata: { pid: 42 } }; }
    }))).rejects.toThrow(/does not identify the executing implementation artifact/i);
    expect(starts).toBe(0);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("turns parser and deterministic gate failures into explicit schema_failed terminals", async () => {
    const parserDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-parser-"));
    const parserResult = await runPhase1Screen(spec(parserDir), adapter({
      async invoke() { return { status: "completed", rawOutput: "not json", parsedOutput: { stale: true }, gatedOutput: { stale: true } }; }
    }));
    expect(parserResult.counts.schema_failed).toBe(2);
    expect(JSON.parse(readFileSync(join(parserDir, "results", "warm-8k", "pr-1.json"), "utf8"))).not.toHaveProperty("parsedOutput");
    expect(JSON.parse(readFileSync(join(parserDir, "results", "warm-8k", "pr-1.json"), "utf8"))).not.toHaveProperty("gatedOutput");

    const gateDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-gate-"));
    const gateSpec = spec(gateDir);
    gateSpec.gate = {
      version: "phase1-gate/v1",
      requiredTopLevelKeys: ["findings"],
      sha256: digest("phase1-gate/v1:findings")
    };
    const gateResult = await runPhase1Screen(gateSpec, adapter({
      async invoke() { return { status: "completed", rawOutput: "{}", parsedOutput: { stale: true }, gatedOutput: { stale: true } }; }
    }));
    expect(gateResult.counts.schema_failed).toBe(2);
    expect(JSON.parse(readFileSync(join(gateDir, "results", "warm-8k", "pr-1.json"), "utf8"))).not.toHaveProperty("parsedOutput");
    expect(JSON.parse(readFileSync(join(gateDir, "results", "warm-8k", "pr-1.json"), "utf8"))).not.toHaveProperty("gatedOutput");
  });

  it("rejects unsafe output placement and prompt/input identity drift before writing evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-safe-root-"));
    const outside = spec(join(root, "outside"));
    outside.safeOutputRoot = join(root, "allowed");
    await expect(runPhase1Screen(outside, adapter())).rejects.toThrow(/safe output root/i);
    expect(existsSync(outside.outputDir)).toBe(false);

    const insideCheckout = spec(join(harnessRepo, "runtime", "forbidden-phase1"));
    insideCheckout.safeOutputRoot = join(harnessRepo, "runtime");
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
    const result = await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("swap") });
    expect(result.counts.stopped).toBeGreaterThan(0);
    const resource = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resource.samples.at(-1).phase).toBe("stopped");
    expect(resource.monitorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.monitorIdentity).toMatchObject({ exportName: "createMonitor", moduleSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it("reconstructs pre-crash per-invocation samples before resuming monitored work", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-resume-"));
    const identity = monitorModule("normal");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "resources", "warm-8k.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));

    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const resource = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resource.samples.filter((sample: { phase: string }) => sample.phase === "before")).toHaveLength(2);
    expect(resource.samples.filter((sample: { phase: string }) => sample.phase === "after")).toHaveLength(2);
  });

  it("fails closed when a monitored partial result has no reconstructable resource samples", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-resume-missing-"));
    const identity = monitorModule("normal");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const firstPath = join(outputDir, "results", "warm-8k", "pr-1.json");
    const first = JSON.parse(readFileSync(firstPath, "utf8"));
    delete first.resourceSamples;
    const { evidenceSha256: _discarded, ...body } = first;
    writeFileSync(firstPath, JSON.stringify({ ...body, evidenceSha256: evidenceDigest(body) }));
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "resources", "warm-8k.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));

    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/reconstructable resource samples/i);
  });

  it.each(["sample-nan", "sample-infinity", "sample-negative", "stop-nan"])(
    "fails closed without null serialization for invalid resource numeric data: %s",
    async (kind) => {
      const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-resource-invalid-${kind}-`));
      await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule(kind) })).rejects.toThrow(/resource sample.*(?:finite|nonnegative)/i);
      const evidenceFiles = [
        join(outputDir, "resources", "warm-8k.json"),
        join(outputDir, "results", "warm-8k", "pr-1.json"),
        join(outputDir, "results", "warm-8k", "pr-2.json")
      ].filter(existsSync);
      for (const path of evidenceFiles) expect(readFileSync(path, "utf8")).not.toMatch(/:\s*null/);
      expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
    }
  );

  it("rejects an invalid numeric sample while reconstructing monitored resume evidence", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-resource-invalid-resume-"));
    const identity = monitorModule("normal");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const firstPath = join(outputDir, "results", "warm-8k", "pr-1.json");
    const first = JSON.parse(readFileSync(firstPath, "utf8"));
    first.resourceSamples[0].rssBytes = -1;
    const { evidenceSha256: _discarded, ...body } = first;
    writeFileSync(firstPath, JSON.stringify({ ...body, evidenceSha256: evidenceDigest(body) }));
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "resources", "warm-8k.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));

    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/resource sample.*nonnegative/i);
  });

  it("loads a fresh monitor module namespace for every run", async () => {
    const identity = monitorModule("normal");
    const firstDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-fresh-first-"));
    const secondDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-fresh-second-"));
    await runPhase1Screen(spec(firstDir), adapter(), { monitorModule: identity });
    await runPhase1Screen(spec(secondDir), adapter(), { monitorModule: identity });
    const first = JSON.parse(readFileSync(join(firstDir, "resources", "warm-8k.json"), "utf8"));
    const second = JSON.parse(readFileSync(join(secondDir, "resources", "warm-8k.json"), "utf8"));
    expect(first.samples[0].rssBytes).toBe(101);
    expect(second.samples[0].rssBytes).toBe(101);
  });

  it("binds frozen factory parameters into monitor identity and resume fingerprints", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-parameters-"));
    const identity = monitorModule("factory-parameters");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    expect(manifest.monitorIdentity.factoryParameters).toEqual({ nvidiaSmiSha256: "a".repeat(64) });
    const resources = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resources.samples.some((sample: { factoryParametersBound?: number }) => sample.factoryParametersBound === 1)).toBe(true);

    const drift = { ...identity, factoryParameters: { nvidiaSmiSha256: "b".repeat(64) } };
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: drift })).rejects.toThrow(/manifest fingerprint mismatch/i);
  });

  it("rejects secret-like monitor factory parameters before writing evidence", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-parameter-secret-"));
    const identity = { ...monitorModule("normal"), factoryParameters: { token: "sk-secret-value-1234567890" } };
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/secret-like text/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("attaches the pinned monitor after resident start and persists a bounded stop trace array", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-attach-"));
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("stop-array") });
    const resource = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resource.samples.map((sample: { phase: string }) => sample.phase)).toEqual(["before", "after", "before", "after", "periodic", "stopped"]);
  });

  it("fails closed and stops the resident when monitor attachment fails", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-attach-fail-"));
    let stopped = false;
    let invoked = false;
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async invoke() { invoked = true; return { status: "completed", rawOutput: "{}" }; },
      async stop() { stopped = true; }
    }), { monitorModule: monitorModule("attach-error") })).rejects.toThrow(/monitor attach exploded/i);
    expect(stopped).toBe(true);
    expect(invoked).toBe(false);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it("preserves completed results when attachment fails during a partial resume", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-attach-resume-"));
    const identity = monitorModule("conditional-attach-error");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const completedPath = join(outputDir, "results", "warm-8k", "pr-1.json");
    const completedBytes = readFileSync(completedPath);
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));

    await expect(runPhase1Screen(spec(outputDir), adapter({
      async start() { return { id: "resident", argv: ["/opt/llama-server"], metadata: { pid: 42, failAttach: true } }; }
    }), { monitorModule: identity })).rejects.toThrow(/monitor attach exploded/i);
    expect(readFileSync(completedPath)).toEqual(completedBytes);
  });

  it("cleans up the resident and monitor when attach-failure result persistence also fails", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-attach-write-fail-"));
    const resultsPath = join(outputDir, "results");
    let stopped = false;
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async start() {
        writeFileSync(resultsPath, "blocks result directory");
        return { id: "resident", argv: ["/opt/llama-server"], metadata: { pid: 42 } };
      },
      async stop() {
        stopped = true;
        rmSync(resultsPath);
      }
    }), { monitorModule: monitorModule("attach-error") })).rejects.toThrow();
    expect(stopped).toBe(true);
    expect(existsSync(join(outputDir, "resources", "warm-8k.json"))).toBe(true);
  });

  it("retains ordered attachment and cleanup failures", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-multi-failure-"));
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async stop() { throw new Error("resident stop exploded"); }
    }), { monitorModule: monitorModule("attach-and-stop-error") })).rejects.toThrow(/monitor attach exploded.*resident stop exploded.*monitor stop exploded/i);
  });

  it("rejects unsafe resident evidence before it can reach monitor attachment", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-attach-secret-"));
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async start() {
        return { id: "resident", argv: ["/opt/llama-server"], logs: "Authorization: Bearer sk-secret-value-1234567890", metadata: { pid: 42 } };
      }
    }), { monitorModule: monitorModule("attach-unsafe-probe") })).rejects.toThrow(/secret-like text/i);
    const resources = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resources.samples.every((sample: { attachObserved?: number }) => sample.attachObserved === 0)).toBe(true);
  });

  it("preserves reconstructed resource samples when a resumed monitor returns a terminal trace array", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-resume-trace-"));
    const identity = monitorModule("stop-array");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const firstResult = JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8"));
    const reconstructedCapturedAt = firstResult.resourceSamples.map((sample: { capturedAt: string }) => sample.capturedAt);
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));

    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const resources = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resources.samples.map((sample: { capturedAt: string }) => sample.capturedAt)).toEqual(expect.arrayContaining(reconstructedCapturedAt));
  });

  it("excludes reconstructed history from resumed terminal classification while retaining it as evidence", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-current-terminal-classification-"));
    const identity = monitorModule("attempt-tagged");
    let starts = 0;
    const taggedAdapter = adapter({
      async start() {
        starts += 1;
        return { id: `resident-${starts}`, argv: ["/opt/llama-server"], metadata: { pid: 42, attemptTag: starts === 1 ? "old" : "current" } };
      }
    });
    await runPhase1Screen(spec(outputDir), taggedAdapter, { monitorModule: identity });
    const existingPath = join(outputDir, "results", "warm-8k", "pr-1.json");
    const existingBytes = readFileSync(existingPath);
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "resources", "warm-8k.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));
    const result = await runPhase1Screen(spec(outputDir), taggedAdapter, { monitorModule: identity });
    expect(result.status).toBe("completed");
    expect(readFileSync(existingPath)).toEqual(existingBytes);
    const resources = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resources.samples.some((sample: { attemptTag: string }) => sample.attemptTag === "old")).toBe(true);
    expect(resources.samples.some((sample: { attemptTag: string }) => sample.attemptTag === "current")).toBe(true);
    expect(resources.terminalClassification).toBeUndefined();
  });

  it("rejects an empty terminal monitor trace", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-empty-stop-"));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("stop-empty") })).rejects.toThrow(/terminal trace.*empty/i);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it("rejects relative or package imports because pinned monitors load as self-contained exact bytes", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-relative-import-"));
    const identity = monitorModule("normal");
    writeFileSync(identity.modulePath, `import helper from "./helper.mjs";\nexport function createMonitor(){ return helper; }\n`);
    identity.moduleSha256 = digest(readFileSync(identity.modulePath));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/self-contained.*unsupported import/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("rejects file URL static imports from an otherwise pinned monitor", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-file-import-"));
    const identity = monitorModule("normal");
    writeFileSync(identity.modulePath, `import helper from "file:///tmp/helper.mjs";\nexport function createMonitor(){ return helper; }\n`);
    identity.moduleSha256 = digest(readFileSync(identity.modulePath));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/self-contained.*unsupported import/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("rejects computed dynamic imports regardless of their eventual specifier", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-dynamic-import-"));
    const identity = monitorModule("normal");
    writeFileSync(identity.modulePath, `const prefix = "node:";\nexport async function createMonitor(){ return import(prefix + "fs"); }\n`);
    identity.moduleSha256 = digest(readFileSync(identity.modulePath));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/dynamic import syntax is forbidden/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it.each(["node:module", "node:vm", "node:worker_threads"])("rejects monitor module-loading escape hatch %s", async (specifier) => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-escape-"));
    const identity = monitorModule("normal");
    writeFileSync(identity.modulePath, `import * as escape from ${JSON.stringify(specifier)};\nexport function createMonitor(){ return escape; }\n`);
    identity.moduleSha256 = digest(readFileSync(identity.modulePath));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/escape hatch.*forbidden/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("rejects process.getBuiltinModule monitor escape hatches", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-runtime-escape-"));
    const identity = monitorModule("normal");
    writeFileSync(identity.modulePath, `export function createMonitor(){ return process.getBuiltinModule("module").createRequire(import.meta.url); }\n`);
    identity.moduleSha256 = digest(readFileSync(identity.modulePath));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/runtime module-loading escape hatch/i);
  });

  it("rejects resource monitor source-byte drift before monitor execution", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-drift-"));
    const drift = { ...monitorModule("normal"), moduleSha256: "0".repeat(64) };
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: drift })).rejects.toThrow(/monitor source SHA-256/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("rejects a monitor module changed after its immutable identity was captured", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-mutated-"));
    const identity = monitorModule("normal");
    writeFileSync(identity.modulePath, `${readFileSync(identity.modulePath, "utf8")}\n// changed after pin\n`);
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity })).rejects.toThrow(/monitor source SHA-256/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("rejects arbitrary injected monitor methods instead of trusting an unrelated object", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-injected-"));
    const options = { monitor: { start() {}, sample() {}, stop() {} } } as unknown as Parameters<typeof runPhase1Screen>[2];
    await expect(runPhase1Screen(spec(outputDir), adapter(), options)).rejects.toThrow(/injected resource monitor methods are forbidden/i);
  });

  it.each(["before", "after", "classify"] as const)("treats monitor %s exceptions as infrastructure failures", async (stage) => {
    const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-monitor-${stage}-`));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule(`throw-${stage}`) })).rejects.toThrow(/monitor.*exploded/i);
    const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
    expect(summary.infrastructureErrorCode).toContain("monitor_");
  });

  it("stops and persists monitor evidence when resident startup fails", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-start-fail-"));
    await expect(runPhase1Screen(spec(outputDir), adapter({ async start() { throw new Error("resident startup failed"); } }), { monitorModule: monitorModule("normal") })).rejects.toThrow(/resident startup failed/i);
    expect(existsSync(join(outputDir, "resources", "warm-8k.json"))).toBe(true);
  });

  it("finalizes monitor evidence even when resident startup and terminal-result persistence both fail", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-start-write-fail-"));
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async start(context) {
        writeFileSync(join(context.outputDir, "results"), "blocks result directory");
        throw new Error("resident startup failed");
      }
    }), { monitorModule: monitorModule("normal") })).rejects.toThrow();
    expect(existsSync(join(outputDir, "resources", "warm-8k.json"))).toBe(true);
  });

  it("stops resident and monitor when unsafe resident evidence cannot persist terminal results", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-unsafe-write-fail-"));
    let stopped = false;
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async start(context) {
        writeFileSync(join(context.outputDir, "results"), "blocks result directory");
        return { id: "resident", argv: ["/opt/llama-server"], logs: "Authorization: Bearer sk-secret-value-1234567890", metadata: { pid: 42 } };
      },
      async stop() { stopped = true; }
    }), { monitorModule: monitorModule("attach-unsafe-probe") })).rejects.toThrow();
    expect(stopped).toBe(true);
    const resources = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resources.samples.every((sample: { attachObserved?: number }) => sample.attachObserved === 0)).toBe(true);
  });

  it("records valid empty resource evidence when the monitor itself cannot start", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-start-error-"));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("start-error") })).rejects.toThrow(/monitor start exploded/i);
    const resource = JSON.parse(readFileSync(join(outputDir, "resources", "warm-8k.json"), "utf8"));
    expect(resource.samples).toEqual([]);
    expect(resource.terminalInfrastructureErrorCode).toBe("monitor_start_exploded");
    expect(resource.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["start-null", "start-undefined", "start-empty"])("rejects malformed monitor session %s with durable evidence", async (kind) => {
    const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-monitor-session-${kind}-`));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule(kind) })).rejects.toThrow(/monitor session/i);
    expect(existsSync(join(outputDir, "resources", "warm-8k.json"))).toBe(true);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it.each(["classify-invalid-status", "classify-missing-code", "classify-scalar"])("rejects malformed monitor classification %s", async (kind) => {
    const outputDir = mkdtempSync(join(tmpdir(), `neondiff-phase1-monitor-classification-${kind}-`));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule(kind) })).rejects.toThrow(/monitor classification/i);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it("falls back to root unavailable evidence when monitor start fails and resources is unwritable", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-start-fallback-"));
    writeFileSync(join(outputDir, "resources"), "blocks directory");
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("start-error") })).rejects.toThrow(/monitor start exploded/i);
    expect(existsSync(join(outputDir, "resource-unavailable-warm-8k.json"))).toBe(true);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it("fails closed with resumable unavailable evidence when monitor stop data is secret-like", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-secret-stop-"));
    const monitorModuleIdentity = monitorModule("secret-stop");
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModuleIdentity })).rejects.toThrow(/monitor evidence finalization/i);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
    const unavailable = JSON.parse(readFileSync(join(outputDir, "resource-unavailable-warm-8k.json"), "utf8"));
    expect(unavailable.unavailable).toBe(true);
    expect(JSON.stringify(unavailable)).not.toContain("sk-secret");
    const resumed = await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModuleIdentity });
    expect(resumed.status).toBe("failed");
  });

  it("scans arbitrary fingerprint-like keys in nested resource evidence", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-secret-fingerprint-"));
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("secret-fingerprint-stop") })).rejects.toThrow(/monitor evidence finalization/i);
    const unavailable = readFileSync(join(outputDir, "resource-unavailable-warm-8k.json"), "utf8");
    expect(unavailable).not.toContain("sk-secret");
  });

  it("uses a root-level unavailable record when the resource evidence directory cannot be written", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-write-fail-"));
    writeFileSync(join(outputDir, "resources"), "blocks resource directory");
    await expect(runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("normal") })).rejects.toThrow(/monitor evidence finalization/i);
    expect(existsSync(join(outputDir, "resource-unavailable-warm-8k.json"))).toBe(true);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it("turns a stop-time monitor OOM classification into terminal results and a failed verdict", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-stop-oom-"));
    const result = await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: monitorModule("stop-oom") });
    expect(result.status).toBe("failed");
    expect(result.counts.oom).toBe(2);
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });

  it("does not rewrite a prior completed result when a resumed attempt stops with OOM", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-monitor-resume-stop-oom-"));
    const identity = monitorModule("conditional-stop-oom");
    await runPhase1Screen(spec(outputDir), adapter(), { monitorModule: identity });
    const existingPath = join(outputDir, "results", "warm-8k", "pr-1.json");
    const existingBytes = readFileSync(existingPath);
    rmSync(join(outputDir, "results", "warm-8k", "pr-2.json"));
    rmSync(join(outputDir, "summary.json"));
    rmSync(join(outputDir, "COMPLETED"));

    const resumed = await runPhase1Screen(spec(outputDir), adapter({
      async start() { return { id: "resident", argv: ["/opt/llama-server"], metadata: { pid: 42, forceStopOom: true } }; }
    }), { monitorModule: identity });
    expect(resumed.status).toBe("failed");
    expect(readFileSync(existingPath)).toEqual(existingBytes);
    expect(JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-2.json"), "utf8"))).toMatchObject({ status: "oom" });
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

  it("waits for a recovered stale journal process to exit after SIGKILL before starting a replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-stale-journal-"));
    const outputDir = join(root, "evidence");
    const port = 29000 + Math.floor(Math.random() * 2000);
    const stale = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    expect(stale.pid).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const script = join(root, "replacement-server.mjs");
    writeFileSync(script, `
      import http from "node:http";
      const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
      const server = http.createServer((req, res) => {
        if (req.url === "/health") { res.end("ok"); return; }
        req.resume(); req.on("end", () => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: "{}" } }] })); });
      });
      server.listen(port, "127.0.0.1");
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
    `);
    const modelPath = join(root, "model.gguf");
    writeFileSync(modelPath, "model");
    const runSpec = spec(outputDir);
    runSpec.target.modelPath = modelPath;
    runSpec.target.modelSha256 = digest(readFileSync(modelPath));
    runSpec.target.executable = process.execPath;
    runSpec.target.executableSha256 = digest(readFileSync(process.execPath));
    runSpec.target.args = [script, "--model", modelPath, "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "8192"];
    rmSync(outputDir, { recursive: true, force: true });
    writeFileSync(join(root, "placeholder"), "");
    const processDir = join(outputDir, "processes");
    // The runner creates outputDir before adapter startup, but the stale
    // journal must exist before entry, so create the exact safe hierarchy.
    mkdirSync(processDir, { recursive: true });
    writeFileSync(join(processDir, "warm-8k.json"), JSON.stringify({
      schemaVersion: "neondiff-phase1-resident/v1",
      state: "running",
      pid: stale.pid,
      processGroupId: stale.pid,
      executableSha256: runSpec.target.executableSha256,
      argvFingerprint: "stale-argv"
    }));
    let replacementOwnershipCheckedAfterExit = false;
    const result = await runPhase1Screen(runSpec, createLlamaServerExecutableAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      readinessTimeoutMs: 5_000,
      stopTimeoutMs: 1_000,
      ownershipVerifierSha256: ownershipProof.ownershipVerifierSha256,
      async verifyProcessIdentity() { return true; },
      async verifyListenerOwnership() {
        replacementOwnershipCheckedAfterExit = stale.exitCode !== null || stale.signalCode !== null;
        return replacementOwnershipCheckedAfterExit;
      }
    }));
    expect(result.status).toBe("completed");
    expect(replacementOwnershipCheckedAfterExit).toBe(true);
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

  it("serializes stale lease recovery through a crash-released loopback coordinator", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-stale-lease-"));
    writeFileSync(join(outputDir, ".phase1-run.lock"), JSON.stringify({ pid: 999_999_999 }));
    const result = await runPhase1Screen(spec(outputDir), adapter());
    expect(result.status).toBe("completed");

    const blockedDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-coordinated-lease-"));
    const blockedLeasePath = join(blockedDir, ".phase1-run.lock");
    const coordinator = createNetServer((socket) => {
      socket.once("error", () => {});
      socket.write("neondiff-phase1-lease-v1:");
      setImmediate(() => socket.end(`${digest(resolve(blockedLeasePath))}\n`));
    });
    await new Promise<void>((resolvePromise) => coordinator.listen({
      host: "127.0.0.1",
      port: phase1LeaseCoordinationPort(blockedLeasePath),
      exclusive: true
    }, resolvePromise));
    try {
      await expect(runPhase1Screen(spec(blockedDir), adapter())).rejects.toThrow(/lease acquisition is already coordinated/i);
    } finally {
      await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
    }
  });

  it("falls through a loopback coordination-port collision owned by a different output path", async () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-phase1-port-collision-"));
    const seen = new Map<number, string>();
    let collision: { first: string; second: string; port: number } | undefined;
    for (let index = 0; index < 2_000 && !collision; index += 1) {
      const candidate = join(root, `candidate-${index}`);
      const port = phase1LeaseCoordinationPort(join(candidate, ".phase1-run.lock"));
      const first = seen.get(port);
      if (first) collision = { first, second: candidate, port };
      else seen.set(port, candidate);
    }
    expect(collision).toBeDefined();
    const coordinator = createNetServer((socket) => {
      socket.once("error", () => {});
      socket.end(`neondiff-phase1-lease-v1:${digest(resolve(join(collision!.first, ".phase1-run.lock")))}\n`);
    });
    await new Promise<void>((resolvePromise) => coordinator.listen({ host: "127.0.0.1", port: collision!.port, exclusive: true }, resolvePromise));
    try {
      await expect(runPhase1Screen(spec(collision!.second), adapter())).resolves.toMatchObject({ status: "completed" });
    } finally {
      await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
    }
  });

  it("blocks a same-path legacy raw-token coordinator during mixed-version acquisition", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-legacy-coordinator-"));
    const leasePath = join(outputDir, ".phase1-run.lock");
    const coordinator = createNetServer((socket) => {
      socket.once("error", () => {});
      const token = digest(resolve(leasePath));
      socket.write(token.slice(0, 17));
      setImmediate(() => socket.end(`${token.slice(17)}\n`));
    });
    await new Promise<void>((resolvePromise) => coordinator.listen({
      host: "127.0.0.1",
      port: phase1LeaseCoordinationPort(leasePath),
      exclusive: true
    }, resolvePromise));
    try {
      await expect(runPhase1Screen(spec(outputDir), adapter())).rejects.toThrow(/lease acquisition is already coordinated/i);
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
    }
  });

  it("fails closed when an occupied lease coordination port returns an incomplete token", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-inconclusive-coordinator-"));
    const leasePath = join(outputDir, ".phase1-run.lock");
    let connections = 0;
    const coordinator = createNetServer((socket) => {
      connections += 1;
      socket.once("error", () => {});
      socket.end("neondiff-phase1-lease-v1:partial-token");
    });
    await new Promise<void>((resolvePromise) => coordinator.listen({
      host: "127.0.0.1",
      port: phase1LeaseCoordinationPort(leasePath),
      exclusive: true
    }, resolvePromise));
    try {
      await expect(runPhase1Screen(spec(outputDir), adapter())).rejects.toThrow(/coordination probe.*inconclusive/i);
      expect(existsSync(leasePath)).toBe(false);
      expect(connections).toBe(3);
    } finally {
      await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
    }
  });

  it("falls through an occupied coordination port owned by a foreign protocol", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-foreign-coordinator-"));
    const leasePath = join(outputDir, ".phase1-run.lock");
    const coordinator = createNetServer((socket) => {
      socket.once("error", () => {});
      socket.end("HTTP/1.1 204 No Content\r\n\r\n");
    });
    await new Promise<void>((resolvePromise) => coordinator.listen({
      host: "127.0.0.1",
      port: phase1LeaseCoordinationPort(leasePath),
      exclusive: true
    }, resolvePromise));
    try {
      await expect(runPhase1Screen(spec(outputDir), adapter())).resolves.toMatchObject({ status: "completed" });
    } finally {
      await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
    }
  });

  it("bounds a slow-drip partial lease frame with an absolute probe deadline", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-drip-coordinator-"));
    const leasePath = join(outputDir, ".phase1-run.lock");
    let connections = 0;
    const coordinator = createNetServer((socket) => {
      connections += 1;
      socket.once("error", () => {});
      let offset = 0;
      const prefix = "neondiff-phase1-lease-v1:";
      const interval = setInterval(() => {
        if (offset < prefix.length) socket.write(prefix[offset++]);
      }, 100);
      socket.once("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolvePromise) => coordinator.listen({
      host: "127.0.0.1",
      port: phase1LeaseCoordinationPort(leasePath),
      exclusive: true
    }, resolvePromise));
    const startedAt = Date.now();
    try {
      await expect(runPhase1Screen(spec(outputDir), adapter())).rejects.toThrow(/coordination probe.*inconclusive/i);
      expect(Date.now() - startedAt).toBeLessThan(4500);
      expect(connections).toBe(3);
    } finally {
      await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
    }
  }, 6000);

  it("treats EPERM from process liveness probing as a live lease owner", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-eperm-lease-"));
    writeFileSync(join(outputDir, ".phase1-run.lock"), JSON.stringify({ pid: 424242 }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      const error = new Error("not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    });
    try {
      await expect(runPhase1Screen(spec(outputDir), adapter())).rejects.toThrow(/active exclusive run lease/i);
    } finally {
      kill.mockRestore();
    }
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

  it("pairs different target execution identities while rejecting context drift", async () => {
    const leftDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-target-pair-left-"));
    const rightDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-target-pair-right-"));
    const rightSpec = spec(rightDir);
    rightSpec.target = {
      ...rightSpec.target,
      id: "different-model-and-offload",
      modelPath: "/models/other.gguf",
      modelSha256: "b".repeat(64),
      executable: "/opt/other-llama-server",
      executableSha256: "c".repeat(64),
      args: ["--model", "/models/other.gguf", "--ctx-size", "8192", "--n-gpu-layers", "30"]
    };
    await runPhase1Screen(spec(leftDir), adapter());
    await runPhase1Screen(rightSpec, adapter());
    expect(verifyPairedPhase1Cohort(join(leftDir, "manifest.json"), join(rightDir, "manifest.json"))).toMatchObject({ ok: true });

    const rightManifestPath = join(rightDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(rightManifestPath, "utf8"));
    manifest.cells[0].contextTokens += 1;
    writeFileSync(rightManifestPath, JSON.stringify(manifest));
    expect(() => verifyPairedPhase1Cohort(join(leftDir, "manifest.json"), rightManifestPath)).toThrow(/paired cohort drift/i);
  });

  it("rejects target-independent cell runtime-argument drift in a paired cohort", async () => {
    const leftDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-cell-args-left-"));
    const rightDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-cell-args-right-"));
    const rightSpec = spec(rightDir);
    rightSpec.cells[0].executableArgs = ["--threads", "8"];
    await runPhase1Screen(spec(leftDir), adapter());
    await runPhase1Screen(rightSpec, adapter());
    expect(() => verifyPairedPhase1Cohort(join(leftDir, "manifest.json"), join(rightDir, "manifest.json"))).toThrow(/paired cohort drift.*cells/i);
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

  it("runs resident recovery for every cell before an all-results fast-path return", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-fast-recovery-"));
    let recoveries = 0;
    const recovering = adapter({ async recover() { recoveries += 1; } });
    await runPhase1Screen(spec(outputDir), recovering);
    expect(recoveries).toBe(1);
    await runPhase1Screen(spec(outputDir), recovering);
    expect(recoveries).toBe(2);
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
      expect(JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8"))).toMatchObject({ residentTerminal: true, invocationDisposition: "invoked" });
      expect(JSON.parse(readFileSync(join(outputDir, "results", "warm-8k", "pr-2.json"), "utf8"))).toMatchObject({ residentTerminal: true, invocationDisposition: "not_invoked_resident_terminal" });
    }
  );

  it("rejects non-finite required metrics", async () => {
    for (const metric of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-nonfinite-metric-"));
      const runSpec = spec(outputDir);
      runSpec.request.requiredMetrics = ["latencyMs"];
      const result = await runPhase1Screen(runSpec, adapter({
        async invoke() { return { status: "completed", rawOutput: "{}", metrics: { latencyMs: metric } }; }
      }));
      expect(result.counts.schema_failed).toBe(2);
    }
  });

  it("rejects non-finite optional metrics before evidence is fingerprinted", async () => {
    for (const metric of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-nonfinite-optional-metric-"));
      const result = await runPhase1Screen(spec(outputDir), adapter({
        async invoke() { return { status: "completed", rawOutput: "{}", metrics: { optionalDiagnostic: metric } }; }
      }));
      expect(result.counts.schema_failed).toBe(2);
      const persisted = readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8");
      expect(persisted).not.toMatch(/optionalDiagnostic|null/);
    }
  });

  it("rejects negative latency metrics before evidence is fingerprinted", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-negative-latency-"));
    const result = await runPhase1Screen(spec(outputDir), adapter({
      async invoke() { return { status: "completed", rawOutput: "{}", metrics: { latencyMs: -1 } }; }
    }));
    expect(result.counts.schema_failed).toBe(2);
  });

  it("scans arbitrary nested fingerprint-like keys while accepting runner-owned digests", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-nested-secret-"));
    const summary = await runPhase1Screen(spec(outputDir), adapter({
      async invoke() {
        return { status: "completed", rawOutput: JSON.stringify({ runFingerprint: "sk-secret-value-1234567890" }) };
      }
    }));
    expect(summary.counts.failed).toBe(2);
    expect(JSON.stringify(summary)).not.toContain("sk-secret");
    expect(readFileSync(join(outputDir, "results", "warm-8k", "pr-1.json"), "utf8")).not.toContain("sk-secret");
    expect(existsSync(join(outputDir, "COMPLETED"))).toBe(false);
  });

  it.each([
    ["prompt template", (runSpec: Phase1RunSpec) => {
      runSpec.prompt.template = "Authorization: Bearer sk-secret-value-1234567890 {{input}}";
      runSpec.prompt.templateSha256 = digest(runSpec.prompt.template);
    }],
    ["response format", (runSpec: Phase1RunSpec) => { runSpec.request.responseFormat = { nested: "sk-secret-value-1234567890" }; }],
    ["cell executable args", (runSpec: Phase1RunSpec) => { runSpec.cells[0].executableArgs = ["--api-key", "sk-secret-value-1234567890"]; }]
  ] as const)("rejects secret-like text in the full manifest %s before writing", async (_label, mutate) => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-manifest-secret-"));
    const runSpec = spec(outputDir);
    mutate(runSpec);
    await expect(runPhase1Screen(runSpec, adapter())).rejects.toThrow(/secret-like text/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("does not exempt exact runner-owned digest names inside untrusted manifest metadata", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-manifest-exact-key-secret-"));
    const runSpec = spec(outputDir);
    runSpec.inputs[0].metadata = { nested: { targetFingerprint: "sk-secret-value-1234567890" } };
    await expect(runPhase1Screen(runSpec, adapter())).rejects.toThrow(/secret-like text/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

  it("scans secret-like JSON object keys in untrusted payloads", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-secret-key-"));
    const runSpec = spec(outputDir);
    runSpec.inputs[0].metadata = { "Authorization: Bearer sk-secret-value-1234567890": "safe" };
    await expect(runPhase1Screen(runSpec, adapter())).rejects.toThrow(/secret-like text/i);
    expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
  });

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

  it("fails closed when an infrastructure exception has an empty message", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-phase1-empty-stop-failure-"));
    await expect(runPhase1Screen(spec(outputDir), adapter({
      async stop() { throw new Error(""); }
    }))).rejects.toThrow(/infrastructure_failure/i);
    const summary = JSON.parse(readFileSync(join(outputDir, "summary.json"), "utf8"));
    expect(summary.status).toBe("failed");
    expect(summary.infrastructureErrorCode).toBe("infrastructure_failure");
    expect(existsSync(join(outputDir, "FAILED"))).toBe(true);
  });
});
