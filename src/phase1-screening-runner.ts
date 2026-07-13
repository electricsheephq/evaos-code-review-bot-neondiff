import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  createReadStream,
  realpathSync,
  closeSync,
  linkSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { connect, createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import {
  createLlamaCppStartupCapture,
  LLAMA_CPP_STARTUP_MAX_BYTES,
  LLAMA_CPP_STARTUP_MAX_LINES,
  llamaCppPlacementAttestationModulePath,
  parseLlamaCppPlacementAttestation,
  type LlamaCppPlacementProfile,
  type LlamaCppPlacementReceipt,
  type LlamaCppStartupCapture,
  type LlamaCppStartupSource,
  type LlamaCppStartupStream
} from "./llama-cpp-placement-attestation.js";

export type Phase1TerminalStatus = "completed" | "failed" | "stopped" | "oom" | "schema_failed";

export interface Phase1Target {
  id: string;
  modelPath: string;
  modelSha256: string;
  backendCommit: string;
  executable: string;
  executableSha256: string;
  ownershipVerifierSha256?: string;
  args: string[];
  servingParameters?: Record<string, unknown>;
}

export interface Phase1Cell {
  id: string;
  contextTokens: number;
  repetition: number;
  executableArgs?: string[];
  parameters?: Record<string, unknown>;
  placement?: Phase1PlacementPolicy;
}

export interface Phase1PlacementPolicy {
  mode: "offload_comparison";
  profile: LlamaCppPlacementProfile;
  requestedGpuLayers: number | "all";
  expectedCpuMoe?: {
    requestKind: "all" | "first_n";
    firstLayer: number;
    lastLayer: number;
    layerCount: number;
    minimumMatchedTensors: number;
  };
  parserVersion: "llama.cpp-b9977-placement/v2";
  parserSourcePath: string;
  parserSourceSha256: string;
  maxStartupBytes: number;
  maxStartupLines: number;
}

export interface Phase1ResidentPlacementEvidence {
  source: LlamaCppStartupSource;
  receipt: LlamaCppPlacementReceipt;
  processStartReceiptSha256: string;
  processStartReceiptRelativePath: string;
  processAttestationFingerprint: string;
}

export interface Phase1Input {
  id: string;
  sha256: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface Phase1RunSpec {
  outputDir: string;
  safeOutputRoot: string;
  checkoutRoot: string;
  target: Phase1Target;
  cells: Phase1Cell[];
  inputs: Phase1Input[];
  prompt: { version: string; template: string; templateSha256: string; parameters?: Record<string, unknown> };
  request: { version: string; stream: boolean; outputBudgetTokens: number; requiredMetrics: string[]; responseFormat?: unknown; parameters: Record<string, unknown> };
  harness: {
    commit: string;
    sourcePath: string;
    sourceSha256: string;
    entrypointPath: string;
    entrypointSha256: string;
    runnerPath: string;
    runnerSha256: string;
  };
  parser: { version: string; format: "json"; sha256: string };
  gate: { version: string; requiredTopLevelKeys: string[]; sha256: string };
}

export interface Phase1Resident {
  id: string;
  argv: string[];
  logs?: string;
  metadata?: Record<string, unknown>;
  placementEvidence?: Phase1ResidentPlacementEvidence;
}

export interface Phase1InvocationResult {
  status: Phase1TerminalStatus;
  rawOutput?: string;
  parsedOutput?: unknown;
  gatedOutput?: unknown;
  metrics?: Record<string, number>;
  errorCode?: string;
  logs?: string;
  resourceSamples?: Phase1ResourceSample[];
  residentTerminal?: boolean;
  invocationDisposition?: "invoked" | "not_invoked_resident_terminal" | "not_invoked_infrastructure";
  retryCount?: number;
}

export interface Phase1ResidentAdapter {
  recover?(context: {
    outputDir: string;
    target: Phase1Target;
    cell: Phase1Cell;
    targetFingerprint: string;
    cellFingerprint: string;
  }): Promise<void>;
  start(context: {
    outputDir: string;
    target: Phase1Target;
    cell: Phase1Cell;
    targetFingerprint: string;
    cellFingerprint: string;
  }): Promise<Phase1Resident>;
  invoke(resident: Phase1Resident, request: {
    input: Phase1Input;
    cell: Phase1Cell;
    renderedPrompt: string;
    request: Phase1RunSpec["request"];
    promptFingerprint: string;
    parserFingerprint: string;
    gateFingerprint: string;
  }): Promise<Phase1InvocationResult>;
  stop(resident: Phase1Resident): Promise<void>;
}

type Counts = Record<Phase1TerminalStatus, number>;

export interface Phase1RunSummary {
  schemaVersion: "neondiff-phase1-screen-summary/v1";
  runFingerprint: string;
  status: "completed" | "failed";
  counts: Counts;
  expectedResults: number;
  recordedResults: number;
  infrastructureErrorCode?: string;
  summarySha256: string;
  claimClass: "transport_and_gate_only";
}

export interface LlamaServerExecutableAdapterOptions {
  baseUrl: string;
  readinessTimeoutMs?: number;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  maxResponseBytes?: number;
  verifyListenerOwnership?: (pid: number, host: string, port: number) => Promise<boolean>;
  verifyProcessIdentity?: (pid: number, executableSha256: string, argvFingerprint: string) => Promise<boolean>;
  ownershipVerifierSha256?: string;
}


export interface Phase1ResourceSample {
  capturedAt: string;
  phase: string;
  rssBytes: number;
  vramBytes: number;
  swapBytes: number;
  [key: string]: string | number;
}

export interface Phase1ResourceMonitor {
  start(context: { target: Phase1Target; cell: Phase1Cell; outputDir: string }): Promise<{ id: string }>;
  attach?(session: { id: string }, resident: Phase1Resident): Promise<void>;
  sample(session: { id: string }, context: { phase: "before" | "after"; input: Phase1Input }): Promise<Phase1ResourceSample>;
  classify?(samples: Phase1ResourceSample[]): { status: "failed" | "stopped" | "oom"; errorCode: string } | undefined;
  /** An array is the complete ordered current-attempt trace; a scalar is one terminal delta. */
  stop(session: { id: string }): Promise<Phase1ResourceSample | Phase1ResourceSample[]>;
}

export interface Phase1ResourceMonitorModule {
  version: string;
  modulePath: string;
  moduleSha256: string;
  approvedRoot: string;
  exportName: string;
  factoryParameters?: Readonly<Record<string, string>>;
}

export interface Phase1RunnerOptions {
  monitorModule?: Phase1ResourceMonitorModule;
}

export function phase1ScreeningRunnerModulePath(): string {
  return fileURLToPath(import.meta.url);
}

type ResolvedRunnerOptions = { monitor?: Phase1ResourceMonitor; monitorIdentity?: Phase1ResourceMonitorModule };

type ResidentProcess = {
  process: ChildProcess;
  unsafeEvidence: boolean;
  exited: boolean;
  stderrTail: string;
  placementCapture?: LlamaCppStartupCapture;
  placementCaptureError?: Error;
};

/**
 * Owns an unregistered llama-server subprocess for exactly one screening cell.
 * It never installs a service, mutates config, posts to GitHub, or inherits
 * credential values through command arguments.
 */
export function createLlamaServerExecutableAdapter(
  options: LlamaServerExecutableAdapterOptions
): Phase1ResidentAdapter {
  const residents = new Map<string, ResidentProcess>();
  const endpoint = new URL(options.baseUrl);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port) {
    throw new Error("llama-server executable adapter requires an explicit HTTP loopback endpoint on 127.0.0.1");
  }
  if (!options.verifyListenerOwnership || !options.verifyProcessIdentity || !/^[a-f0-9]{64}$/.test(options.ownershipVerifierSha256 ?? "")) {
    throw new Error("llama-server executable adapter requires listener and process ownership verifiers");
  }
  const verifyListenerOwnership = options.verifyListenerOwnership;
  const verifyProcessIdentity = options.verifyProcessIdentity;
  const baseUrl = endpoint.origin;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10 * 60_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
  const maxResponseBytes = options.maxResponseBytes ?? 8 * 1024 * 1024;
  return {
    async recover({ target, cell, outputDir }) {
      await recoverResidentJournal(join(outputDir, "processes", `${cell.id}.json`), target.executableSha256, verifyProcessIdentity, stopTimeoutMs);
    },
    async start({ target, cell, outputDir }) {
      const effectiveArgs = [...target.args, ...(cell.executableArgs ?? [])];
      const argv = [target.executable, ...effectiveArgs];
      const argvFingerprint = fingerprint(argv);
      if (target.ownershipVerifierSha256 !== options.ownershipVerifierSha256) throw new Error("listener ownership verifier fingerprint does not match the immutable target");
      assertSecretSafe("llama-server argv", argv.join("\n"));
      if (!hasFlagValue(effectiveArgs, "--host", "127.0.0.1") || !hasFlagValue(effectiveArgs, "--port", endpoint.port)) {
        throw new Error("llama-server loopback host and port must match the immutable target argv");
      }
      if (!hasFlagValue(effectiveArgs, "--ctx-size", String(cell.contextTokens))) {
        throw new Error("llama-server context size must match the immutable screening cell");
      }
      if (!hasFlagValue(effectiveArgs, "--model", target.modelPath)) {
        throw new Error("llama-server model path must match the immutable target argv");
      }
      if (cell.placement) {
        const argvGpuLayers = readGpuLayerRequest(effectiveArgs);
        if (argvGpuLayers !== cell.placement.requestedGpuLayers) throw new Error("llama-server GPU-layer request does not match the immutable placement policy");
        assertPlacementDebugVerbosity(effectiveArgs);
        const cpuMoeRequest = readCpuMoeRequest(effectiveArgs);
        if (cell.placement.profile === "all_plus_cpu_moe") {
          if (!cpuMoeRequest || !cell.placement.expectedCpuMoe) throw new Error("llama-server CPU-MoE request does not match the immutable placement policy");
          const expectedCpuMoe = cell.placement.expectedCpuMoe;
          if ((cpuMoeRequest.kind === "all" && expectedCpuMoe.requestKind !== "all")
            || (cpuMoeRequest.kind === "first_n"
              && (expectedCpuMoe.requestKind !== "first_n"
                || expectedCpuMoe.firstLayer !== 0
                || expectedCpuMoe.lastLayer !== cpuMoeRequest.count - 1
                || expectedCpuMoe.layerCount !== cpuMoeRequest.count))) {
            throw new Error("llama-server ranged CPU-MoE request does not match the immutable placement policy");
          }
        } else if (cpuMoeRequest) {
          throw new Error("llama-server CPU-MoE request does not match the immutable placement policy");
        }
      }
      const actualExecutableSha256 = await sha256File(target.executable);
      if (actualExecutableSha256 !== target.executableSha256) {
        throw new Error("llama-server executable SHA-256 does not match the immutable target");
      }
      const actualModelSha256 = await sha256File(target.modelPath);
      if (actualModelSha256 !== target.modelSha256) throw new Error("llama-server model SHA-256 does not match the immutable target");
      const journalPath = join(outputDir, "processes", `${cell.id}.json`);
      await recoverResidentJournal(journalPath, target.executableSha256, verifyProcessIdentity, stopTimeoutMs);
      await assertEndpointUnbound(endpoint.hostname, Number(endpoint.port));
      const child = spawn(target.executable, effectiveArgs, {
        env: minimalProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true
      });
      const id = randomUUID();
      const loadStartedAt = performance.now();
      const startedAt = new Date().toISOString();
      const processStartReceiptRelativePath = join("processes", `${cell.id}.${id}.start.json`);
      const processStartReceiptPath = join(outputDir, processStartReceiptRelativePath);
      const processStartBody = {
        schemaVersion: "neondiff-phase1-resident-start/v1" as const,
        pid: child.pid,
        processGroupId: child.pid,
        executableSha256: target.executableSha256,
        argvFingerprint,
        ownershipVerifierSha256: target.ownershipVerifierSha256,
        targetId: target.id,
        cellId: cell.id,
        startedAt
      };
      const processStartRecord = { ...processStartBody, evidenceSha256: fingerprint(processStartBody) };
      const state: ResidentProcess = {
        process: child,
        unsafeEvidence: false,
        exited: false,
        stderrTail: "",
        placementCapture: cell.placement
          ? createLlamaCppStartupCapture({ maxBytes: cell.placement.maxStartupBytes, maxLines: cell.placement.maxStartupLines })
          : undefined
      };
      residents.set(id, state);
      const inspectChunk = (stream: LlamaCppStartupStream) => (chunk: Buffer): void => {
        // These scans are intentionally independent and union-fail: the outer UTF-8 scan
        // covers the resident lifecycle, while the bounded startup capture scans raw bytes
        // across chunk boundaries and treats any capture error as terminal for this resident.
        const text = chunk.toString("utf8");
        state.unsafeEvidence ||= containsSecretLikeText(text);
        state.stderrTail = `${state.stderrTail}${redactSecrets(text)}`.slice(-4096);
        if (state.placementCapture && !state.placementCaptureError) {
          try { state.placementCapture.push({ stream, chunk }); }
          catch (error) { state.placementCaptureError = error instanceof Error ? error : new Error("llama.cpp placement capture failed"); }
        }
      };
      child.stdout?.on("data", inspectChunk("stdout"));
      child.stderr?.on("data", inspectChunk("stderr"));
      child.once("exit", () => { state.exited = true; });
      child.once("error", (error) => {
        state.exited = true;
        state.stderrTail = redactSecrets(error.message).slice(-4096);
      });
      let placementEvidence: Phase1ResidentPlacementEvidence | undefined;
      try {
        atomicCreateJson(processStartReceiptPath, processStartRecord);
        atomicWriteJson(journalPath, {
          schemaVersion: "neondiff-phase1-resident/v1",
          state: "running",
          pid: child.pid,
          processGroupId: child.pid,
          executableSha256: target.executableSha256,
          argvFingerprint,
          targetId: target.id,
          cellId: cell.id,
          startedAt,
          processStartReceiptRelativePath,
          processStartReceiptSha256: processStartRecord.evidenceSha256
        });
        await waitForHealthy(baseUrl, readinessTimeoutMs, state);
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (state.exited) throw new Error(`llama-server exited after readiness: ${state.stderrTail || "no redacted diagnostics"}`);
        if (!child.pid || !await verifyListenerOwnership(child.pid, endpoint.hostname, Number(endpoint.port))) {
          throw new Error("llama-server listener ownership could not be proven for the spawned PID");
        }
        if (!child.pid || !await verifyProcessIdentity(child.pid, target.executableSha256, argvFingerprint)) {
          throw new Error("llama-server process identity could not be proven for the spawned PID");
        }
        if (state.placementCaptureError) throw state.placementCaptureError;
        if (state.unsafeEvidence) throw new Error("llama-server emitted secret-like text during startup");
        if (cell.placement) {
          if (!state.placementCapture) throw new Error("llama.cpp placement capture is unavailable");
          const source = state.placementCapture.finalize();
          const receipt = parseLlamaCppPlacementAttestation(source, {
            backendCommit: target.backendCommit,
            profile: cell.placement.profile,
            requestedGpuLayers: cell.placement.requestedGpuLayers,
            expectedCpuMoe: cell.placement.expectedCpuMoe
          });
          placementEvidence = {
            source,
            receipt,
            processStartReceiptSha256: processStartRecord.evidenceSha256,
            processStartReceiptRelativePath,
            processAttestationFingerprint: fingerprint(processStartBody)
          };
        }
      } catch (error) {
        try { await stopProcess(state, stopTimeoutMs); }
        catch (cleanupError) {
          residents.delete(id);
          throw new Error(`resident startup failed and cleanup was not proven: ${errorMessage(cleanupError)}`);
        }
        residents.delete(id);
        throw error;
      }
      return {
        id,
        argv,
        metadata: { baseUrl, pid: child.pid, journalPath, modelId: target.id, loadDurationMs: Math.max(0, performance.now() - loadStartedAt) },
        placementEvidence
      };
    },
    async invoke(resident, request) {
      const state = residents.get(resident.id);
      if (!state) return { status: "stopped", errorCode: "resident_not_found" };
      if (state.unsafeEvidence) return { status: "failed", errorCode: "secret_like_runtime_log" };
      if (state.exited) return classifyExitedResident(state);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...request.request.parameters,
            model: resident.metadata?.modelId,
            messages: [{ role: "user", content: request.renderedPrompt }],
            stream: request.request.stream,
            max_tokens: request.request.outputBudgetTokens,
            ...(request.request.responseFormat === undefined ? {} : { response_format: request.request.responseFormat })
          }),
          signal: controller.signal
        });
        if (!response.ok) return { status: "failed", errorCode: `http_${response.status}` };
        if (request.request.stream) {
          const streamed = await readStreamingAssistant(response, maxResponseBytes, requestStartedAt);
          assertSecretSafe("llama-server assistant content", streamed.content);
          return { status: "completed", rawOutput: streamed.content, metrics: streamed.metrics };
        }
        const envelopeText = await readResponseBody(response, maxResponseBytes);
        assertSecretSafe("llama-server response envelope", envelopeText);
        let envelope: unknown;
        try {
          envelope = JSON.parse(envelopeText);
        } catch {
          return { status: "schema_failed", errorCode: "invalid_response_envelope" };
        }
        const content = readAssistantContent(envelope);
        if (content === undefined) return { status: "schema_failed", errorCode: "missing_assistant_content" };
        assertSecretSafe("llama-server assistant content", content);
        const metrics = readResponseMetrics(envelope, performance.now() - requestStartedAt);
        return { status: "completed", rawOutput: content, metrics };
      } catch (error) {
        if (state.unsafeEvidence) return { status: "failed", errorCode: "secret_like_runtime_log" };
        if (state.exited) return classifyExitedResident(state);
        return {
          status: error instanceof Error && error.name === "AbortError" ? "stopped" : "failed",
          errorCode: error instanceof Error && error.name === "AbortError" ? "request_timeout" : "request_failed"
        };
      } finally {
        clearTimeout(timer);
      }
    },
    async stop(resident) {
      const state = residents.get(resident.id);
      if (!state) return;
      await stopProcess(state, stopTimeoutMs);
      residents.delete(resident.id);
      const journalPath = typeof resident.metadata?.journalPath === "string" ? resident.metadata.journalPath : undefined;
      if (journalPath) atomicWriteJson(journalPath, {
        ...parseJson<Record<string, unknown>>(journalPath),
        state: "stopped",
        stoppedAt: new Date().toISOString()
      });
      if (state.unsafeEvidence) throw new Error("llama-server emitted secret-like text during execution");
    }
  };
}

type Manifest = {
  schemaVersion: "neondiff-phase1-screen-manifest/v1";
  runFingerprint: string;
  targetFingerprint: string;
  promptFingerprint: string;
  parserFingerprint: string;
  gateFingerprint: string;
  requestFingerprint: string;
  monitorFingerprint: string;
  monitorIdentity: Phase1ResourceMonitorModule | { version: "none"; moduleSha256: string; modulePath: "none"; approvedRoot: "none"; exportName: "none" };
  harnessFingerprint: string;
  target: Phase1Target;
  prompt: Phase1RunSpec["prompt"];
  parser: Phase1RunSpec["parser"];
  gate: Phase1RunSpec["gate"];
  request: Phase1RunSpec["request"];
  harness: Phase1RunSpec["harness"];
  cells: Array<Phase1Cell & { fingerprint: string; cohortFingerprint: string; effectiveArgvFingerprint: string }>;
  inputs: Array<Omit<Phase1Input, "prompt"> & { fingerprint: string; promptSha256: string }>;
};

/**
 * Proves that two completed run manifests describe the same paired cohort.
 * Target identity is intentionally excluded: a paired screen changes the
 * model target while holding every review input and harness contract fixed.
 */
export function verifyPairedPhase1Cohort(
  leftManifestPath: string,
  rightManifestPath: string
): { ok: true; cohortFingerprint: string } {
  const left = parseJson<Manifest>(leftManifestPath);
  const right = parseJson<Manifest>(rightManifestPath);
  assertPairedManifestIntegrity(left, "left");
  assertPairedManifestIntegrity(right, "right");
  for (const [name, leftValue, rightValue] of [
    ["prompt", left.promptFingerprint, right.promptFingerprint],
    ["parser", left.parserFingerprint, right.parserFingerprint],
    ["gate", left.gateFingerprint, right.gateFingerprint],
    ["request", left.requestFingerprint, right.requestFingerprint],
    ["monitor", left.monitorFingerprint, right.monitorFingerprint],
    ["harness", left.harnessFingerprint, right.harnessFingerprint],
    ["cells", fingerprint(left.cells.map(pairedCellIdentity)), fingerprint(right.cells.map(pairedCellIdentity))],
    ["inputs", fingerprint(left.inputs), fingerprint(right.inputs)]
  ] as const) {
    if (leftValue !== rightValue) throw new Error(`paired cohort drift detected in ${name}`);
  }
  const cohort = {
    promptFingerprint: left.promptFingerprint,
    parserFingerprint: left.parserFingerprint,
    gateFingerprint: left.gateFingerprint,
    requestFingerprint: left.requestFingerprint,
    monitorFingerprint: left.monitorFingerprint,
    monitorIdentity: left.monitorIdentity,
    harnessFingerprint: left.harnessFingerprint,
    cells: left.cells.map(pairedCellIdentity),
    inputs: left.inputs
  };
  return { ok: true, cohortFingerprint: fingerprint(cohort) };
}

function pairedCellIdentity(cell: Manifest["cells"][number]): Record<string, unknown> {
  return {
    id: cell.id,
    contextTokens: cell.contextTokens,
    repetition: cell.repetition,
    parameters: cell.parameters,
    executableArgs: cell.executableArgs,
    cohortFingerprint: cell.cohortFingerprint
  };
}

function assertPairedManifestIntegrity(manifest: Manifest, side: string): void {
  for (const [name, declared, actual] of [
    ["target", manifest.targetFingerprint, fingerprint(manifest.target)],
    ["prompt", manifest.promptFingerprint, fingerprint(manifest.prompt)],
    ["parser", manifest.parserFingerprint, fingerprint(manifest.parser)],
    ["gate", manifest.gateFingerprint, fingerprint(manifest.gate)],
    ["request", manifest.requestFingerprint, fingerprint(manifest.request)],
    ["monitor", manifest.monitorFingerprint, fingerprint(manifest.monitorIdentity)],
    ["harness", manifest.harnessFingerprint, fingerprint(manifest.harness)]
  ] as const) {
    if (declared !== actual) throw new Error(`paired cohort drift detected in ${name} (${side} manifest integrity)`);
  }
  const { runFingerprint, ...identity } = manifest;
  if (runFingerprint !== fingerprint(identity)) throw new Error(`paired cohort drift detected in run identity (${side} manifest integrity)`);
}

export async function runPhase1Screen(
  spec: Phase1RunSpec,
  adapter: Phase1ResidentAdapter,
  options: Phase1RunnerOptions = {}
): Promise<Phase1RunSummary> {
  validateSpec(spec);
  if ("monitor" in (options as object)) throw new Error("injected resource monitor methods are forbidden; configure a pinned monitor module");
  if (options.monitorModule && !/^[a-f0-9]{64}$/.test(options.monitorModule.moduleSha256)) throw new Error("resource monitor module requires a SHA-256 source fingerprint");
  validateOutputBoundary(spec);
  mkdirSync(spec.outputDir, { recursive: true, mode: 0o700 });
  const leasePath = join(spec.outputDir, ".phase1-run.lock");
  const lease = await acquireRunLease(leasePath);
  try {
    return await runPhase1ScreenWithLease(spec, adapter, options);
  } finally {
    closeSync(lease);
    rmSync(leasePath, { force: true });
  }
}

async function runPhase1ScreenWithLease(
  spec: Phase1RunSpec,
  adapter: Phase1ResidentAdapter,
  options: Phase1RunnerOptions
): Promise<Phase1RunSummary> {
  for (const [label, path, expectedSha256] of [
    ["harness entrypoint", spec.harness.entrypointPath, spec.harness.entrypointSha256],
    ["screening runner", spec.harness.runnerPath, spec.harness.runnerSha256]
  ] as const) {
    if (realpathSync(path) !== path) throw new Error(`${label} must be an absolute canonical file`);
    if (await sha256File(path) !== expectedSha256) throw new Error(`${label} SHA-256 does not match the implementation artifact`);
  }
  if (realpathSync(spec.harness.runnerPath) !== realpathSync(phase1ScreeningRunnerModulePath())) {
    throw new Error("screening runner path does not identify the executing implementation artifact");
  }
  const actualHarnessSha256 = await sha256File(spec.harness.sourcePath);
  if (actualHarnessSha256 !== spec.harness.sourceSha256) throw new Error("harness source SHA-256 does not match the implementation artifact");
  const harnessRelativePath = relative(spec.checkoutRoot, spec.harness.sourcePath);
  if (!harnessRelativePath || harnessRelativePath.startsWith(`..${sep}`) || harnessRelativePath === ".." || resolve(spec.checkoutRoot, harnessRelativePath) !== resolve(spec.harness.sourcePath)) {
    throw new Error("harness source must be a repository-relative path inside checkoutRoot");
  }
  if (!gitCommitContainsBytes(spec.checkoutRoot, spec.harness.commit, harnessRelativePath, spec.harness.sourceSha256)) {
    throw new Error("harness source bytes are not present at the declared commit");
  }
  if (options.monitorModule) await verifyResourceMonitorModuleIdentity(options.monitorModule);
  const resolvedOptions: ResolvedRunnerOptions = options.monitorModule ? { monitorIdentity: options.monitorModule } : {};
  assertSecretSafe("target argv", [spec.target.executable, ...spec.target.args].join("\n"));
  assertJsonValuesSecretSafe("target manifest", spec.target);
  const manifest = buildManifest(spec, resolvedOptions.monitorIdentity);
  assertManifestPayloadSecretSafe(spec);
  const manifestPath = join(spec.outputDir, "manifest.json");
  if (existsSync(manifestPath)) {
    const existing = parseJson<Manifest>(manifestPath);
    if (existing.runFingerprint !== manifest.runFingerprint || canonicalJson(existing) !== canonicalJson(manifest)) {
      throw new Error("phase 1 manifest fingerprint mismatch; resume requires an exact immutable manifest");
    }
  } else {
    atomicWriteJson(manifestPath, manifest);
  }
  for (const cell of manifest.cells) {
    if (adapter.recover) await adapter.recover({
      outputDir: spec.outputDir,
      target: spec.target,
      cell,
      targetFingerprint: manifest.targetFingerprint,
      cellFingerprint: cell.fingerprint
    });
  }
  let missingResults = 0;
  for (const cell of manifest.cells) {
    for (const input of spec.inputs) {
      const path = resultFile(spec.outputDir, cell.id, input.id);
      if (existsSync(path)) validateExistingResult(path, manifest, cell.fingerprint, input);
      else missingResults += 1;
    }
    if (resolvedOptions.monitorIdentity) {
      const resourcePath = join(spec.outputDir, "resources", `${cell.id}.json`);
      const unavailablePath = join(spec.outputDir, `resource-unavailable-${cell.id}.json`);
      if (existsSync(resourcePath)) validateResourceEvidence(resourcePath, manifest, cell.fingerprint);
      else if (existsSync(unavailablePath)) validateResourceEvidence(unavailablePath, manifest, cell.fingerprint);
      else if (spec.inputs.every((input) => existsSync(resultFile(spec.outputDir, cell.id, input.id)))) {
        throw new Error(`terminal resource evidence is missing for cell ${cell.id}`);
      }
    }
    if (cell.placement) {
      const [placementPath, sourcePath] = placementEvidencePaths(spec.outputDir, cell.id);
      const unavailablePath = placementUnavailablePath(spec.outputDir, cell.id);
      const anyResultExists = spec.inputs.some((input) => existsSync(resultFile(spec.outputDir, cell.id, input.id)));
      const anyResultMissing = spec.inputs.some((input) => !existsSync(resultFile(spec.outputDir, cell.id, input.id)));
      if (existsSync(placementPath) || existsSync(sourcePath)) {
        if (existsSync(unavailablePath)) throw new Error(`placement evidence conflicts with unavailable evidence for cell ${cell.id}`);
        validatePlacementEvidence(spec.outputDir, manifest, cell);
        if (anyResultMissing) {
          throw new Error(`placement evidence exists while terminal results are missing for cell ${cell.id}; manual reconciliation is required`);
        }
      }
      else if (existsSync(unavailablePath)) {
        validatePlacementUnavailable(unavailablePath, manifest, cell);
        if (anyResultMissing) {
          throw new Error(`placement unavailable evidence exists while terminal results are missing for cell ${cell.id}; manual reconciliation is required`);
        }
      }
      else if (anyResultExists) throw new Error(`terminal placement evidence is missing for cell ${cell.id}`);
    }
  }
  if (missingResults === 0) {
    const existingSummaryPath = join(spec.outputDir, "summary.json");
    const summary = existsSync(existingSummaryPath)
      ? validateExistingSummary(existingSummaryPath, manifest, spec.outputDir)
      : buildSummary(spec.outputDir, manifest);
    return finalizeRun(spec.outputDir, summary);
  }
  rmSync(join(spec.outputDir, "COMPLETED"), { force: true });
  rmSync(join(spec.outputDir, "FAILED"), { force: true });
  atomicWriteText(join(spec.outputDir, "RUNNING"), `${manifest.runFingerprint}\n`);

  let infrastructureFailure: string | undefined;
  if (resolvedOptions.monitorIdentity) {
    try { resolvedOptions.monitor = await loadResourceMonitorModule(resolvedOptions.monitorIdentity); }
    catch (error) { infrastructureFailure = `resource monitor module load failed: ${errorMessage(error)}`; }
  }
  for (const cell of manifest.cells) {
    const cellHasWork = spec.inputs.some((input) => !existsSync(resultFile(spec.outputDir, cell.id, input.id)));
    if (!cellHasWork) continue;
    const preexistingResultPaths = new Set(spec.inputs
      .map((input) => resultFile(spec.outputDir, cell.id, input.id))
      .filter((path) => existsSync(path)));
    let monitorSession: { id: string } | undefined;
    const resourceSamples: Phase1ResourceSample[] = resolvedOptions.monitorIdentity
      ? reconstructResourceSamples(spec.outputDir, manifest, cell)
      : [];
    const attemptSamples: Phase1ResourceSample[] = [];
    if (resolvedOptions.monitor) {
      try { monitorSession = validateMonitorSession(await resolvedOptions.monitor.start({ target: spec.target, cell, outputDir: spec.outputDir })); }
      catch (error) { infrastructureFailure = errorMessage(error); }
    }
    const resident = infrastructureFailure ? undefined : await startResident(adapter, spec, manifest, cell).catch((error) => {
      infrastructureFailure = errorMessage(error);
      return undefined;
    });
    if (!resident) {
      try {
        if (cell.placement) writePlacementUnavailable(spec.outputDir, manifest, cell, infrastructureFailure ?? "resident_start_failed");
        for (const input of spec.inputs) writeMissingTerminalResult(spec.outputDir, manifest, cell, input, infrastructureFailure ?? "resident_start_failed");
      } catch (writeError) {
        infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `terminal result write after resident start failure failed: ${errorMessage(writeError)}`);
      } finally {
        if (resolvedOptions.monitor && monitorSession) {
          const finalized = await finalizeMonitorEvidence(resolvedOptions.monitor, monitorSession, resourceSamples, attemptSamples, spec.outputDir, manifest, cell);
          if (finalized.infrastructureFailure) infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, finalized.infrastructureFailure);
          if (finalized.terminalClassification) rewriteCellTerminalResults(spec.outputDir, manifest, cell, finalized.terminalClassification, preexistingResultPaths);
        } else if (resolvedOptions.monitorIdentity) {
          writeUnavailableMonitorEvidence(spec.outputDir, manifest, cell, infrastructureFailure ?? "monitor_start_failed");
        }
      }
      continue;
    }
    try {
      assertSecretSafe("resident argv", resident.argv.join("\n"));
      assertSecretSafe("resident logs", resident.logs ?? "");
      if (cell.placement) persistPlacementEvidence(spec.outputDir, manifest, cell, resident);
      else if (resident.placementEvidence) throw new Error("resident returned unrequested placement evidence");
    } catch (error) {
      infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, errorMessage(error));
      try {
        if (cell.placement) writePlacementUnavailable(spec.outputDir, manifest, cell, errorMessage(error));
        for (const input of spec.inputs) writeMissingTerminalResult(spec.outputDir, manifest, cell, input, "resident_evidence_rejected");
      } catch (writeError) {
        infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `terminal result write after resident evidence rejection failed: ${errorMessage(writeError)}`);
      } finally {
        try { await adapter.stop(resident); }
        catch (stopError) { infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `resident stop after evidence rejection failed: ${errorMessage(stopError)}`); }
        if (resolvedOptions.monitor && monitorSession) {
          const finalized = await finalizeMonitorEvidence(resolvedOptions.monitor, monitorSession, resourceSamples, attemptSamples, spec.outputDir, manifest, cell);
          if (finalized.infrastructureFailure) infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, finalized.infrastructureFailure);
        }
      }
      continue;
    }
    if (resolvedOptions.monitor && monitorSession && resolvedOptions.monitor.attach) {
      try { await resolvedOptions.monitor.attach(monitorSession, resident); }
      catch (error) {
        infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `monitor attach failed: ${errorMessage(error)}`);
        try {
          for (const input of spec.inputs) writeMissingTerminalResult(spec.outputDir, manifest, cell, input, "monitor_attach_failed");
        } catch (writeError) {
          infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `terminal result write after monitor attach failure failed: ${errorMessage(writeError)}`);
        } finally {
          try { await adapter.stop(resident); }
          catch (stopError) { infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `resident stop after monitor attach failure failed: ${errorMessage(stopError)}`); }
          const finalized = await finalizeMonitorEvidence(resolvedOptions.monitor, monitorSession, resourceSamples, attemptSamples, spec.outputDir, manifest, cell);
          if (finalized.infrastructureFailure) infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, finalized.infrastructureFailure);
        }
        continue;
      }
    }
    try {
      let cellTerminal: { status: "failed" | "stopped" | "oom"; errorCode: string } | undefined;
      for (const input of spec.inputs) {
        const resultPath = resultFile(spec.outputDir, cell.id, input.id);
        if (existsSync(resultPath)) {
          validateExistingResult(resultPath, manifest, cell.fingerprint, input);
          continue;
        }
        const startedAt = new Date().toISOString();
        let result: Phase1InvocationResult;
        try {
          if (cellTerminal) result = { ...cellTerminal, residentTerminal: true, invocationDisposition: "not_invoked_resident_terminal" };
          else {
            if (resolvedOptions.monitor && monitorSession) {
              const sample = await monitorSample(resolvedOptions.monitor, monitorSession, { phase: "before", input });
              resourceSamples.push(sample);
              attemptSamples.push(sample);
            }
            const renderedPrompt = renderPrompt(spec.prompt.template, input.prompt);
            result = await adapter.invoke(resident, {
              input,
              cell,
              renderedPrompt,
              request: spec.request,
              promptFingerprint: manifest.promptFingerprint,
              parserFingerprint: manifest.parserFingerprint,
              gateFingerprint: manifest.gateFingerprint
            });
            result.invocationDisposition = "invoked";
            if (resolvedOptions.monitor && monitorSession) {
              const sample = await monitorSample(resolvedOptions.monitor, monitorSession, { phase: "after", input });
              resourceSamples.push(sample);
              attemptSamples.push(sample);
              const classification = monitorClassify(resolvedOptions.monitor, attemptSamples);
              if (classification) result = { ...result, ...classification, residentTerminal: true };
            }
          }
          const invalidMetric = findInvalidMetric(result.metrics);
          if (invalidMetric) {
            result = {
              status: "schema_failed",
              errorCode: `invalid_metric_${sanitizeIdentifier(invalidMetric)}`,
              residentTerminal: result.residentTerminal,
              invocationDisposition: result.invocationDisposition,
              retryCount: result.retryCount
            };
          }
          result = applyReviewContract(result, spec);
          if (result.status === "schema_failed") result = { ...result, parsedOutput: undefined, gatedOutput: undefined };
          result.retryCount ??= 0;
          result.metrics = { ...(result.metrics ?? {}), residentLoadDurationMs: numericMetadata(resident.metadata?.loadDurationMs) };
          if (result.status === "completed") {
            const missingMetric = spec.request.requiredMetrics.find((name) => !Number.isFinite(result.metrics?.[name]));
            if (missingMetric) result = { ...result, status: "schema_failed", errorCode: `missing_metric_${sanitizeIdentifier(missingMetric)}` };
          }
          if (result.residentTerminal && (result.status === "failed" || result.status === "stopped" || result.status === "oom")) {
            cellTerminal = { status: result.status, errorCode: result.errorCode ?? `cell_${result.status}` };
          }
          try {
            for (const sample of resourceSamples) validateResourceSample(sample, "result resource sample");
          } catch (error) {
            throw new MonitorInfrastructureError(`monitor resource sample invalid before result persistence: ${errorMessage(error)}`);
          }
          result.resourceSamples = resourceSamples.slice(-2);
          assertTerminalStatus(result.status);
          assertSecretSafe("invocation logs", result.logs ?? "");
          assertSecretSafe("raw output", result.rawOutput ?? "");
        } catch (error) {
          if (error instanceof MonitorInfrastructureError) {
            infrastructureFailure = error.message;
            result = { status: "stopped", errorCode: "monitor_infrastructure_failure", residentTerminal: true, retryCount: 0, invocationDisposition: "invoked" };
            cellTerminal = { status: "stopped", errorCode: "monitor_infrastructure_failure" };
          } else result = { status: "failed", errorCode: safeErrorCode(error), retryCount: 0, invocationDisposition: "invoked" };
        }
        const record = resultRecord(manifest, cell, input, result, startedAt);
        assertResultPayloadSecretSafe(record);
        atomicWriteJson(resultPath, record);
      }
    } catch (error) {
      infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, errorMessage(error));
      for (const input of spec.inputs) writeMissingTerminalResult(spec.outputDir, manifest, cell, input, "resident_evidence_rejected");
    } finally {
      try {
        await adapter.stop(resident);
      } catch (error) {
        infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, errorMessage(error));
      }
      if (resolvedOptions.monitor && monitorSession) {
        const finalized = await finalizeMonitorEvidence(resolvedOptions.monitor, monitorSession, resourceSamples, attemptSamples, spec.outputDir, manifest, cell);
        if (finalized.infrastructureFailure) infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, finalized.infrastructureFailure);
        if (finalized.terminalClassification) rewriteCellTerminalResults(spec.outputDir, manifest, cell, finalized.terminalClassification, preexistingResultPaths);
      }
    }
  }

  const summary = buildSummary(spec.outputDir, manifest, infrastructureFailure);
  finalizeRun(spec.outputDir, summary);
  if (infrastructureFailure) {
    throw new Error(`phase 1 runner infrastructure failure: ${infrastructureFailure}`);
  }
  return summary;
}

function writeUnavailableMonitorEvidence(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number],
  error: string
): void {
  const resourceRecord = {
    schemaVersion: "neondiff-phase1-resources/v1",
    runFingerprint: manifest.runFingerprint,
    cellFingerprint: cell.fingerprint,
    monitorFingerprint: manifest.monitorFingerprint,
    samples: [] as Phase1ResourceSample[],
    terminalInfrastructureErrorCode: sanitizeIdentifier(error)
  };
  assertJsonValuesSecretSafe("resource samples", resourceRecord.samples);
  try {
    atomicWriteJson(join(outputDir, "resources", `${cell.id}.json`), {
      ...resourceRecord,
      evidenceSha256: fingerprint(resourceRecord)
    });
  } catch (error) {
    writeResourceUnavailableFallback(outputDir, manifest, cell, `monitor unavailable evidence write failed: ${errorMessage(error)}`);
  }
}

async function startResident(
  adapter: Phase1ResidentAdapter,
  spec: Phase1RunSpec,
  manifest: Manifest,
  cell: Manifest["cells"][number]
): Promise<Phase1Resident> {
  return adapter.start({
    outputDir: spec.outputDir,
    target: spec.target,
    cell,
    targetFingerprint: manifest.targetFingerprint,
    cellFingerprint: cell.fingerprint
  });
}

function buildManifest(spec: Phase1RunSpec, monitorIdentityInput?: Phase1ResourceMonitorModule): Manifest {
  const targetFingerprint = fingerprint(spec.target);
  const promptFingerprint = fingerprint(spec.prompt);
  const parserFingerprint = fingerprint(spec.parser);
  const gateFingerprint = fingerprint(spec.gate);
  const requestFingerprint = fingerprint(spec.request);
  const harnessFingerprint = fingerprint(spec.harness);
  const monitorIdentity = monitorIdentityInput ?? { version: "none" as const, moduleSha256: sha256("none"), modulePath: "none" as const, approvedRoot: "none" as const, exportName: "none" as const };
  const monitorFingerprint = fingerprint(monitorIdentity);
  const cells = spec.cells.map((cell) => {
    const effectiveArgvFingerprint = fingerprint([spec.target.executable, ...spec.target.args, ...(cell.executableArgs ?? [])]);
    const cohortFingerprint = fingerprint({ id: cell.id, contextTokens: cell.contextTokens, repetition: cell.repetition, parameters: cell.parameters, executableArgs: cell.executableArgs });
    return { ...cell, cohortFingerprint, effectiveArgvFingerprint, fingerprint: fingerprint({ ...cell, cohortFingerprint, effectiveArgvFingerprint }) };
  });
  const inputs = spec.inputs.map(({ prompt, ...input }) => ({
    ...input,
    promptSha256: sha256(prompt),
    fingerprint: fingerprint({ ...input, promptSha256: sha256(prompt) })
  }));
  const identity = {
    schemaVersion: "neondiff-phase1-screen-manifest/v1" as const,
    targetFingerprint,
    promptFingerprint,
    parserFingerprint,
    gateFingerprint,
    requestFingerprint,
    monitorFingerprint,
    monitorIdentity,
    harnessFingerprint,
    target: spec.target,
    prompt: spec.prompt,
    parser: spec.parser,
    gate: spec.gate,
    request: spec.request,
    harness: spec.harness,
    cells,
    inputs
  };
  return { ...identity, runFingerprint: fingerprint(identity) };
}

function resultRecord(
  manifest: Manifest,
  cell: Manifest["cells"][number],
  input: Phase1Input,
  result: Phase1InvocationResult,
  startedAt: string
): Record<string, unknown> {
  const inputManifest = manifest.inputs.find((candidate) => candidate.id === input.id);
  if (!inputManifest) throw new Error(`input ${input.id} is absent from manifest`);
  const record = {
    schemaVersion: "neondiff-phase1-screen-result/v1",
    runFingerprint: manifest.runFingerprint,
    targetFingerprint: manifest.targetFingerprint,
    cellFingerprint: cell.fingerprint,
    inputFingerprint: inputManifest.fingerprint,
    promptFingerprint: manifest.promptFingerprint,
    parserFingerprint: manifest.parserFingerprint,
    gateFingerprint: manifest.gateFingerprint,
    requestFingerprint: manifest.requestFingerprint,
    harnessFingerprint: manifest.harnessFingerprint,
    cellId: cell.id,
    inputId: input.id,
    status: result.status,
    startedAt,
    completedAt: new Date().toISOString(),
    rawOutput: result.rawOutput,
    parsedOutput: result.parsedOutput,
    gatedOutput: result.gatedOutput,
    metrics: result.metrics,
    errorCode: result.errorCode,
    retryCount: result.retryCount ?? 0,
    residentTerminal: result.residentTerminal ?? false,
    invocationDisposition: result.invocationDisposition ?? "invoked",
    resourceSamples: result.resourceSamples
  };
  return { ...record, evidenceSha256: fingerprint(record) };
}

function writeMissingTerminalResult(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number],
  input: Phase1Input,
  errorCode: string
): void {
  const path = resultFile(outputDir, cell.id, input.id);
  if (existsSync(path)) return;
  const now = new Date().toISOString();
  const record = resultRecord(manifest, cell, input, {
    status: "failed",
    errorCode: sanitizeIdentifier(errorCode),
    invocationDisposition: "not_invoked_infrastructure"
  }, now);
  assertResultPayloadSecretSafe(record);
  atomicWriteJson(path, record);
}

function validateExistingResult(
  path: string,
  manifest: Manifest,
  cellFingerprint: string,
  input: Phase1Input
): void {
  const record = parseJson<Record<string, unknown>>(path);
  const expectedInput = manifest.inputs.find((candidate) => candidate.id === input.id);
  const { evidenceSha256, ...recordWithoutSha } = record;
  const expectedEvidenceSha256 = fingerprint(recordWithoutSha);
  if (
    record.schemaVersion !== "neondiff-phase1-screen-result/v1"
    || record.runFingerprint !== manifest.runFingerprint
    || record.targetFingerprint !== manifest.targetFingerprint
    || record.cellFingerprint !== cellFingerprint
    || record.inputFingerprint !== expectedInput?.fingerprint
    || record.promptFingerprint !== manifest.promptFingerprint
    || record.parserFingerprint !== manifest.parserFingerprint
    || record.gateFingerprint !== manifest.gateFingerprint
    || record.requestFingerprint !== manifest.requestFingerprint
    || record.harnessFingerprint !== manifest.harnessFingerprint
    || record.cellId !== manifest.cells.find((cell) => cell.fingerprint === cellFingerprint)?.id
    || record.inputId !== input.id
    || !isTerminalStatus(record.status)
    || evidenceSha256 !== expectedEvidenceSha256
  ) {
    throw new Error(`terminal result fingerprint mismatch at ${path}`);
  }
  if (record.resourceSamples !== undefined) {
    if (!Array.isArray(record.resourceSamples)) throw new Error(`terminal result resource samples are invalid at ${path}`);
    for (const sample of record.resourceSamples) validateResourceSample(sample, `terminal result resource sample at ${path}`);
  }
  assertResultPayloadSecretSafe(record);
}

function reconstructResourceSamples(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number]
): Phase1ResourceSample[] {
  const reconstructed: Phase1ResourceSample[] = [];
  for (const input of manifest.inputs) {
    const path = resultFile(outputDir, cell.id, input.id);
    if (!existsSync(path)) continue;
    const record = parseJson<Record<string, unknown>>(path);
    const disposition = record.invocationDisposition;
    if (disposition === "invoked" && (!Array.isArray(record.resourceSamples) || record.resourceSamples.length === 0)) {
      throw new Error(`monitored result ${cell.id}/${input.id} has no reconstructable resource samples`);
    }
    if (record.resourceSamples !== undefined && !Array.isArray(record.resourceSamples)) {
      throw new Error(`monitored result ${cell.id}/${input.id} has invalid reconstructable resource samples`);
    }
    // Only invoked records own a durable before/after pair. Synthesized
    // resident-terminal records may repeat the preceding pair and must not
    // duplicate it during reconstruction.
    if (disposition === "invoked") {
      for (const sample of record.resourceSamples as Phase1ResourceSample[]) {
        reconstructed.push(validateResourceSample(sample, `reconstructed resource sample ${cell.id}/${input.id}`));
      }
    }
  }
  return reconstructed;
}

function buildSummary(outputDir: string, manifest: Manifest, infrastructureFailure?: string): Phase1RunSummary {
  const counts: Counts = { completed: 0, failed: 0, stopped: 0, oom: 0, schema_failed: 0 };
  for (const cell of manifest.cells) {
    for (const input of manifest.inputs) {
      const record = parseJson<{ status: Phase1TerminalStatus }>(resultFile(outputDir, cell.id, input.id));
      assertTerminalStatus(record.status);
      counts[record.status] += 1;
    }
  }
  const expectedResults = manifest.cells.length * manifest.inputs.length;
  const recordedResults = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const withoutSha = {
    schemaVersion: "neondiff-phase1-screen-summary/v1" as const,
    runFingerprint: manifest.runFingerprint,
    status: infrastructureFailure || counts.failed || counts.stopped || counts.oom || counts.schema_failed ? "failed" as const : "completed" as const,
    counts,
    expectedResults,
    recordedResults,
    infrastructureErrorCode: infrastructureFailure ? sanitizeIdentifier(infrastructureFailure) : undefined,
    claimClass: "transport_and_gate_only" as const
  };
  return { ...withoutSha, summarySha256: fingerprint(withoutSha) };
}

function validateExistingSummary(path: string, manifest: Manifest, outputDir: string): Phase1RunSummary {
  const summary = parseJson<Phase1RunSummary>(path);
  const { summarySha256, ...body } = summary;
  const reconstructed = buildSummary(outputDir, manifest);
  const expectedStatus = summary.infrastructureErrorCode ? "failed" : reconstructed.status;
  if (
    summary.schemaVersion !== "neondiff-phase1-screen-summary/v1"
    || summary.runFingerprint !== manifest.runFingerprint
    || summarySha256 !== fingerprint(body)
    || canonicalJson(summary.counts) !== canonicalJson(reconstructed.counts)
    || summary.expectedResults !== reconstructed.expectedResults
    || summary.recordedResults !== reconstructed.recordedResults
    || summary.status !== expectedStatus
    || summary.claimClass !== "transport_and_gate_only"
  ) {
    throw new Error("phase 1 terminal summary fingerprint mismatch");
  }
  return summary;
}

function validateResourceEvidence(path: string, manifest: Manifest, cellFingerprint: string): void {
  const record = parseJson<Record<string, unknown>>(path);
  const { evidenceSha256, ...body } = record;
  if (
    record.schemaVersion !== "neondiff-phase1-resources/v1"
    || record.runFingerprint !== manifest.runFingerprint
    || record.cellFingerprint !== cellFingerprint
    || record.monitorFingerprint !== manifest.monitorFingerprint
    || evidenceSha256 !== fingerprint(body)
  ) throw new Error(`resource evidence fingerprint mismatch at ${path}`);
  if (!Array.isArray(record.samples)) throw new Error(`resource evidence samples are invalid at ${path}`);
  for (const sample of record.samples) validateResourceSample(sample, `resource evidence sample at ${path}`);
}

function placementEvidencePaths(outputDir: string, cellId: string): [string, string] {
  const root = join(outputDir, "placements", cellId);
  return [join(root, "placement.json"), join(root, "startup-source.json")];
}

function placementUnavailablePath(outputDir: string, cellId: string): string {
  return join(outputDir, `placement-unavailable-${cellId}.json`);
}

function writePlacementUnavailable(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number],
  error: string
): void {
  if (!cell.placement) return;
  const path = placementUnavailablePath(outputDir, cell.id);
  const body = {
    schemaVersion: "neondiff-phase1-placement-unavailable/v1" as const,
    runFingerprint: manifest.runFingerprint,
    targetFingerprint: manifest.targetFingerprint,
    cellFingerprint: cell.fingerprint,
    placementPolicyFingerprint: fingerprint(cell.placement),
    cellId: cell.id,
    terminalErrorCode: sanitizeIdentifier(error)
  };
  const record = { ...body, evidenceSha256: fingerprint(body) };
  if (existsSync(path)) {
    validatePlacementUnavailable(path, manifest, cell);
    return;
  }
  atomicCreateJson(path, record);
}

function validatePlacementUnavailable(path: string, manifest: Manifest, cell: Manifest["cells"][number]): void {
  if (!cell.placement) throw new Error(`placement unavailable evidence is not declared for cell ${cell.id}`);
  const record = parseJson<Record<string, unknown>>(path);
  const { evidenceSha256, ...body } = record;
  if (record.schemaVersion !== "neondiff-phase1-placement-unavailable/v1"
    || record.runFingerprint !== manifest.runFingerprint
    || record.targetFingerprint !== manifest.targetFingerprint
    || record.cellFingerprint !== cell.fingerprint
    || record.placementPolicyFingerprint !== fingerprint(cell.placement)
    || record.cellId !== cell.id
    || typeof record.terminalErrorCode !== "string"
    || evidenceSha256 !== fingerprint(body)) {
    throw new Error(`placement unavailable evidence fingerprint mismatch for cell ${cell.id}`);
  }
  assertSecretSafe("placement unavailable error code", record.terminalErrorCode);
}

function persistPlacementEvidence(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number],
  resident: Phase1Resident
): void {
  if (!cell.placement || !resident.placementEvidence) {
    throw new Error(`required placement evidence is missing for cell ${cell.id}`);
  }
  const [placementPath, sourcePath] = placementEvidencePaths(outputDir, cell.id);
  if (existsSync(placementPath) || existsSync(sourcePath)) {
    validatePlacementEvidence(outputDir, manifest, cell);
    return;
  }
  const sourceBody = {
    schemaVersion: "neondiff-phase1-startup-source/v1" as const,
    runFingerprint: manifest.runFingerprint,
    targetFingerprint: manifest.targetFingerprint,
    cellFingerprint: cell.fingerprint,
    cellId: cell.id,
    parserVersion: cell.placement.parserVersion,
    parserSourceSha256: cell.placement.parserSourceSha256,
    source: resident.placementEvidence.source
  };
  const sourceRecord = { ...sourceBody, evidenceSha256: fingerprint(sourceBody) };
  const placementBody = {
    schemaVersion: "neondiff-phase1-placement/v1" as const,
    runFingerprint: manifest.runFingerprint,
    targetFingerprint: manifest.targetFingerprint,
    servingProfileFingerprint: fingerprint(manifest.target.servingParameters ?? {}),
    placementPolicyFingerprint: fingerprint(cell.placement),
    cellFingerprint: cell.fingerprint,
    cohortFingerprint: cell.cohortFingerprint,
    effectiveArgvFingerprint: cell.effectiveArgvFingerprint,
    harnessFingerprint: manifest.harnessFingerprint,
    monitorFingerprint: manifest.monitorFingerprint,
    cellId: cell.id,
    identity: {
      backendCommit: manifest.target.backendCommit,
      executableSha256: manifest.target.executableSha256,
      modelSha256: manifest.target.modelSha256,
      ownershipVerifierSha256: manifest.target.ownershipVerifierSha256,
      parserVersion: cell.placement.parserVersion,
      parserSourceSha256: cell.placement.parserSourceSha256,
      processStartReceiptSha256: resident.placementEvidence.processStartReceiptSha256,
      processStartReceiptRelativePath: resident.placementEvidence.processStartReceiptRelativePath,
      processAttestationFingerprint: resident.placementEvidence.processAttestationFingerprint
    },
    requested: {
      profile: cell.placement.profile,
      gpuLayers: cell.placement.requestedGpuLayers,
      contextTokens: cell.contextTokens
    },
    observed: resident.placementEvidence.receipt,
    sourceEvidenceSha256: sourceRecord.evidenceSha256
  };
  const placementRecord = { ...placementBody, evidenceSha256: fingerprint(placementBody) };
  assertJsonValuesSecretSafe("placement startup events", resident.placementEvidence.source.events);
  atomicCreateJson(sourcePath, sourceRecord);
  atomicCreateJson(placementPath, placementRecord);
  validatePlacementEvidence(outputDir, manifest, cell);
}

function validatePlacementEvidence(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number]
): void {
  if (!cell.placement) throw new Error(`placement evidence is not declared for cell ${cell.id}`);
  const [placementPath, sourcePath] = placementEvidencePaths(outputDir, cell.id);
  if (!existsSync(placementPath) || !existsSync(sourcePath)) throw new Error(`placement evidence is incomplete for cell ${cell.id}`);
  const sourceRecord = parseJson<Record<string, unknown>>(sourcePath);
  const placementRecord = parseJson<Record<string, unknown>>(placementPath);
  const { evidenceSha256: sourceEvidenceSha256, ...sourceBody } = sourceRecord;
  const { evidenceSha256: placementEvidenceSha256, ...placementBody } = placementRecord;
  if (sourceRecord.schemaVersion !== "neondiff-phase1-startup-source/v1"
    || sourceRecord.runFingerprint !== manifest.runFingerprint
    || sourceRecord.targetFingerprint !== manifest.targetFingerprint
    || sourceRecord.cellFingerprint !== cell.fingerprint
    || sourceRecord.cellId !== cell.id
    || sourceRecord.parserVersion !== cell.placement.parserVersion
    || sourceRecord.parserSourceSha256 !== cell.placement.parserSourceSha256
    || sourceEvidenceSha256 !== fingerprint(sourceBody)) {
    throw new Error(`placement source fingerprint mismatch for cell ${cell.id}`);
  }
  if (placementRecord.schemaVersion !== "neondiff-phase1-placement/v1"
    || placementRecord.runFingerprint !== manifest.runFingerprint
    || placementRecord.targetFingerprint !== manifest.targetFingerprint
    || placementRecord.servingProfileFingerprint !== fingerprint(manifest.target.servingParameters ?? {})
    || placementRecord.placementPolicyFingerprint !== fingerprint(cell.placement)
    || placementRecord.cellFingerprint !== cell.fingerprint
    || placementRecord.cohortFingerprint !== cell.cohortFingerprint
    || placementRecord.effectiveArgvFingerprint !== cell.effectiveArgvFingerprint
    || placementRecord.harnessFingerprint !== manifest.harnessFingerprint
    || placementRecord.monitorFingerprint !== manifest.monitorFingerprint
    || placementRecord.cellId !== cell.id
    || placementRecord.sourceEvidenceSha256 !== sourceEvidenceSha256
    || placementEvidenceSha256 !== fingerprint(placementBody)) {
    throw new Error(`placement evidence fingerprint mismatch for cell ${cell.id}`);
  }
  const identity = placementRecord.identity as Record<string, unknown> | undefined;
  if (!identity
    || identity.backendCommit !== manifest.target.backendCommit
    || identity.executableSha256 !== manifest.target.executableSha256
    || identity.modelSha256 !== manifest.target.modelSha256
    || identity.ownershipVerifierSha256 !== manifest.target.ownershipVerifierSha256
    || identity.parserVersion !== cell.placement.parserVersion
    || identity.parserSourceSha256 !== cell.placement.parserSourceSha256) {
    throw new Error(`placement evidence identity mismatch for cell ${cell.id}`);
  }
  const source = sourceRecord.source as LlamaCppStartupSource;
  const observed = parseLlamaCppPlacementAttestation(source, {
    backendCommit: manifest.target.backendCommit,
    profile: cell.placement.profile,
    requestedGpuLayers: cell.placement.requestedGpuLayers,
    expectedCpuMoe: cell.placement.expectedCpuMoe
  });
  if (canonicalJson(observed) !== canonicalJson(placementRecord.observed)) {
    throw new Error(`placement evidence parsed receipt mismatch for cell ${cell.id}`);
  }
  const journalPath = join(outputDir, "processes", `${cell.id}.json`);
  const journal = parseJson<Record<string, unknown>>(journalPath);
  const startRelativePath = identity.processStartReceiptRelativePath;
  if (typeof startRelativePath !== "string"
    || !new RegExp(`^processes/${escapeRegExp(cell.id)}\\.[a-f0-9-]+\\.start\\.json$`).test(startRelativePath)) {
    throw new Error(`placement process start receipt path mismatch for cell ${cell.id}`);
  }
  const startPath = join(outputDir, startRelativePath);
  const startRecord = parseJson<Record<string, unknown>>(startPath);
  const { evidenceSha256: startEvidenceSha256, ...startBody } = startRecord;
  const processAttestationFingerprint = fingerprint(startBody);
  if (journal.schemaVersion !== "neondiff-phase1-resident/v1"
    || journal.executableSha256 !== manifest.target.executableSha256
    || journal.argvFingerprint !== cell.effectiveArgvFingerprint
    || journal.targetId !== manifest.target.id
    || journal.cellId !== cell.id
    || journal.processGroupId !== journal.pid
    || journal.processStartReceiptRelativePath !== startRelativePath
    || journal.processStartReceiptSha256 !== startEvidenceSha256
    || startRecord.schemaVersion !== "neondiff-phase1-resident-start/v1"
    || startRecord.pid !== journal.pid
    || startRecord.processGroupId !== journal.processGroupId
    || startRecord.executableSha256 !== manifest.target.executableSha256
    || startRecord.argvFingerprint !== cell.effectiveArgvFingerprint
    || startRecord.ownershipVerifierSha256 !== manifest.target.ownershipVerifierSha256
    || startRecord.targetId !== manifest.target.id
    || startRecord.cellId !== cell.id
    || startRecord.startedAt !== journal.startedAt
    || startEvidenceSha256 !== fingerprint(startBody)
    || identity.processStartReceiptSha256 !== startEvidenceSha256
    || identity.processAttestationFingerprint !== processAttestationFingerprint) {
    throw new Error(`placement process attestation mismatch for cell ${cell.id}`);
  }
  assertJsonValuesSecretSafe("placement startup events", source.events);
}

function validateSpec(spec: Phase1RunSpec): void {
  if (!spec.outputDir) throw new Error("outputDir is required");
  if (spec.cells.length === 0 || spec.inputs.length === 0) throw new Error("at least one cell and input are required");
  assertUniqueSafeIds("cell", spec.cells.map((cell) => cell.id));
  assertUniqueSafeIds("input", spec.inputs.map((input) => input.id));
  for (const [label, version] of [
    ["prompt", spec.prompt.version],
    ["request", spec.request.version],
    ["parser", spec.parser.version],
    ["gate", spec.gate.version]
  ] as const) assertProtocolVersion(label, version);
  for (const digest of [spec.target.modelSha256, spec.target.executableSha256, ...(spec.target.ownershipVerifierSha256 ? [spec.target.ownershipVerifierSha256] : []), spec.harness.sourceSha256, spec.harness.entrypointSha256, spec.harness.runnerSha256, spec.prompt.templateSha256, spec.parser.sha256, spec.gate.sha256, ...spec.inputs.map((input) => input.sha256)]) {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("all declared SHA-256 digests must be lowercase 64-character hex");
  }
  if (!/^[a-f0-9]{40}$/.test(spec.harness.commit)) throw new Error("harness commit must be a full 40-character Git SHA");
  if ([spec.harness.sourcePath, spec.harness.entrypointPath, spec.harness.runnerPath].some((path) => resolve(path) !== path)) {
    throw new Error("harness source and loaded JavaScript paths must be absolute");
  }
  const reservedRequestKeys = new Set(["messages", "model", "stream", "response_format", "max_tokens"]);
  for (const key of Object.keys(spec.request.parameters)) if (reservedRequestKeys.has(key)) throw new Error(`reserved request parameter is runner-owned: ${key}`);
  if (!Number.isInteger(spec.request.outputBudgetTokens) || spec.request.outputBudgetTokens <= 0) throw new Error("request output budget must be a positive integer");
  if (resolve(spec.target.modelPath) !== spec.target.modelPath || resolve(spec.target.executable) !== spec.target.executable) throw new Error("model and executable paths must be absolute");
  if (sha256(spec.prompt.template) !== spec.prompt.templateSha256) throw new Error("prompt template SHA-256 mismatch");
  if (!spec.prompt.template.includes("{{input}}")) throw new Error("prompt template must contain {{input}}");
  if (spec.parser.sha256 !== sha256(`${spec.parser.version}:${spec.parser.format}`)) throw new Error("parser contract SHA-256 mismatch");
  if (spec.gate.sha256 !== sha256(`${spec.gate.version}:${spec.gate.requiredTopLevelKeys.join(",")}`)) throw new Error("gate contract SHA-256 mismatch");
  for (const input of spec.inputs) if (input.sha256 !== sha256(input.prompt)) throw new Error(`input ${input.id} SHA-256 does not match prompt bytes`);
  for (const cell of spec.cells) {
    if (!cell.placement) continue;
    const policy = cell.placement;
    if (policy.mode !== "offload_comparison" || policy.parserVersion !== "llama.cpp-b9977-placement/v2") {
      throw new Error(`cell ${cell.id} placement policy is unsupported`);
    }
    if (!(["full_gpu", "partial_gpu", "all_plus_cpu_moe"] as string[]).includes(policy.profile)) {
      throw new Error(`cell ${cell.id} placement profile is unsupported`);
    }
    if (!((policy.requestedGpuLayers === "all")
        || (Number.isSafeInteger(policy.requestedGpuLayers) && (policy.requestedGpuLayers as number) >= 0))
      || !Number.isSafeInteger(policy.maxStartupBytes) || policy.maxStartupBytes <= 0
      || !Number.isSafeInteger(policy.maxStartupLines) || policy.maxStartupLines <= 0) {
      throw new Error(`cell ${cell.id} placement limits are invalid`);
    }
    if (policy.maxStartupBytes > LLAMA_CPP_STARTUP_MAX_BYTES || policy.maxStartupLines > LLAMA_CPP_STARTUP_MAX_LINES) {
      throw new Error(`cell ${cell.id} placement limits exceed the implementation maximum`);
    }
    if (policy.profile === "partial_gpu" && policy.requestedGpuLayers === "all") {
      throw new Error(`cell ${cell.id} partial-GPU placement requires a finite numeric layer request`);
    }
    if (policy.profile === "all_plus_cpu_moe") {
      const expected = policy.expectedCpuMoe;
      if (!expected
        || !(["all", "first_n"] as string[]).includes(expected.requestKind)
        || !Number.isSafeInteger(expected.firstLayer) || expected.firstLayer < 0
        || !Number.isSafeInteger(expected.lastLayer) || expected.lastLayer < expected.firstLayer
        || !Number.isSafeInteger(expected.layerCount) || expected.layerCount !== expected.lastLayer - expected.firstLayer + 1
        || (expected.requestKind === "first_n" && expected.firstLayer !== 0)
        || !Number.isSafeInteger(expected.minimumMatchedTensors) || expected.minimumMatchedTensors < expected.layerCount) {
        throw new Error(`cell ${cell.id} CPU-MoE placement contract is invalid`);
      }
    } else if (policy.expectedCpuMoe !== undefined) {
      throw new Error(`cell ${cell.id} has an unexpected CPU-MoE placement contract`);
    }
    if (!/^[a-f0-9]{64}$/.test(policy.parserSourceSha256)) throw new Error(`cell ${cell.id} placement parser SHA-256 is invalid`);
    if (resolve(policy.parserSourcePath) !== policy.parserSourcePath
      || realpathSync(policy.parserSourcePath) !== realpathSync(llamaCppPlacementAttestationModulePath())
      || sha256(readFileSync(policy.parserSourcePath)) !== policy.parserSourceSha256) {
      throw new Error(`cell ${cell.id} placement parser identity does not match the executing implementation`);
    }
  }
}

function validateOutputBoundary(spec: Phase1RunSpec): void {
  const output = canonicalProspectivePath(spec.outputDir);
  const safeRoot = canonicalProspectivePath(spec.safeOutputRoot);
  const checkout = canonicalProspectivePath(spec.checkoutRoot);
  if (output !== safeRoot && !output.startsWith(`${safeRoot}${sep}`)) throw new Error("outputDir must be inside the declared safe output root");
  if (output === checkout || output.startsWith(`${checkout}${sep}`)) throw new Error("Phase 1 evidence output must remain outside the checkout");
}

function canonicalProspectivePath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

async function acquireRunLease(path: string): Promise<number> {
  const coordinator = await startLeaseCoordinator(path);
  try {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`);
      return fd;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      const prior = parseJson<{ pid?: number }>(path);
      if (typeof prior.pid === "number" && isProcessAlive(prior.pid)) throw new Error(`Phase 1 output has an active exclusive run lease held by PID ${prior.pid}`);
      // Every conforming writer must own the crash-released loopback
      // coordinator before replacing the canonical lease. Build the new lease
      // under a unique name, then atomically replace the verified-stale path;
      // there is no check/remove/reopen window on the canonical path.
      const replacementPath = `${path}.${process.pid}.${randomUUID()}.replacement`;
      const fd = openSync(replacementPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), recovered: true })}\n`);
        renameSync(replacementPath, path);
        return fd;
      } catch (replacementError) {
        closeSync(fd);
        rmSync(replacementPath, { force: true });
        throw replacementError;
      }
    }
  } finally {
    await new Promise<void>((resolvePromise) => coordinator.close(() => resolvePromise()));
  }
}

async function startLeaseCoordinator(path: string): Promise<ReturnType<typeof createServer>> {
  const token = sha256(resolve(path));
  portLoop:
  for (const port of phase1LeaseCoordinationPorts(path)) {
    for (let bindAttempt = 0; bindAttempt < 3; bindAttempt += 1) {
      const coordinator = createServer((socket) => {
        socket.once("error", () => {});
        socket.end(leaseCoordinatorFrame(token));
      });
      try {
        await new Promise<void>((resolvePromise, rejectPromise) => {
          const fail = (error: Error & { code?: string }) => {
            coordinator.removeListener("listening", ready);
            rejectPromise(error);
          };
          const ready = () => {
            coordinator.removeListener("error", fail);
            resolvePromise();
          };
          coordinator.once("error", fail);
          coordinator.once("listening", ready);
          coordinator.listen({ host: "127.0.0.1", port, exclusive: true });
        });
        return coordinator;
      } catch (error) {
        coordinator.removeAllListeners();
        if (!(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EADDRINUSE")) {
          throw new Error(`Phase 1 lease coordination failed: ${errorMessage(error)}`);
        }
        const probe = await probeLeaseCoordinatorToken(port);
        if (probe.status === "vacant") continue;
        if (probe.status === "foreign" || (probe.status === "complete" && probe.token !== token)) continue portLoop;
        if (probe.status === "inconclusive") throw new Error("Phase 1 lease coordination probe was inconclusive");
        throw new Error("Phase 1 lease acquisition is already coordinated by another writer");
      }
    }
    throw new Error("Phase 1 lease coordination probe remained vacant after bounded rebind attempts");
  }
  throw new Error("Phase 1 lease coordination exhausted collision-safe loopback ports");
}

function phase1LeaseCoordinationPorts(path: string): number[] {
  const token = sha256(resolve(path));
  const ports = [phase1LeaseCoordinationPort(path)];
  for (let attempt = 1; attempt < 16; attempt += 1) {
    const port = 20_000 + (Number.parseInt(sha256(`${token}:${attempt}`).slice(0, 8), 16) % 20_000);
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

const LEASE_COORDINATOR_FRAME_PREFIX = "neondiff-phase1-lease-v1:";

function leaseCoordinatorFrame(token: string): string {
  return `${LEASE_COORDINATOR_FRAME_PREFIX}${token}\n`;
}

type LeaseCoordinatorProbe =
  | { status: "complete"; token: string }
  | { status: "foreign" | "inconclusive" | "vacant" };

async function probeLeaseCoordinatorToken(port: number): Promise<LeaseCoordinatorProbe> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = await readLeaseCoordinatorToken(port);
    if (probe.status !== "inconclusive") return probe;
  }
  return { status: "inconclusive" };
}

async function readLeaseCoordinatorToken(port: number): Promise<LeaseCoordinatorProbe> {
  return new Promise((resolvePromise) => {
    let value = "";
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (result: LeaseCoordinatorProbe) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      socket.destroy();
      resolvePromise(result);
    };
    deadline = setTimeout(() => finish({ status: "inconclusive" }), 1000);
    deadline.unref();
    socket.setEncoding("utf8");
    socket.setTimeout(1000);
    socket.on("data", (chunk: string) => {
      value = `${value}${chunk}`.slice(0, 256);
      const match = value.match(new RegExp(`^${LEASE_COORDINATOR_FRAME_PREFIX}([a-f0-9]{64})\\n`));
      const legacyMatch = value.match(/^([a-f0-9]{64})\n/);
      if (match || legacyMatch) finish({ status: "complete", token: (match ?? legacyMatch)![1] });
      else if (
        !LEASE_COORDINATOR_FRAME_PREFIX.startsWith(value)
        && !value.startsWith(LEASE_COORDINATOR_FRAME_PREFIX)
        && !/^[a-f0-9]{0,64}$/.test(value)
      ) finish({ status: "foreign" });
      else if (value.includes("\n")) finish({ status: "inconclusive" });
    });
    socket.once("end", () => finish({ status: "inconclusive" }));
    socket.once("close", () => finish({ status: "inconclusive" }));
    socket.once("timeout", () => finish({ status: "inconclusive" }));
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ status: error.code === "ECONNREFUSED" ? "vacant" : "inconclusive" }));
  });
}

export function phase1LeaseCoordinationPort(path: string): number {
  return 20_000 + (Number.parseInt(sha256(resolve(path)).slice(0, 8), 16) % 20_000);
}

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EEXIST";
}

function renderPrompt(template: string, input: string): string {
  return template.replaceAll("{{input}}", input);
}

function applyReviewContract(result: Phase1InvocationResult, spec: Phase1RunSpec): Phase1InvocationResult {
  if (result.status !== "completed") return result;
  if (typeof result.rawOutput !== "string") return { ...result, status: "schema_failed", errorCode: "missing_raw_output" };
  let parsed: unknown;
  try { parsed = JSON.parse(result.rawOutput); }
  catch { return { ...result, status: "schema_failed", errorCode: "invalid_json_content" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...result, status: "schema_failed", parsedOutput: parsed, errorCode: "gate_requires_object" };
  for (const key of spec.gate.requiredTopLevelKeys) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) return { ...result, status: "schema_failed", parsedOutput: parsed, errorCode: `gate_missing_${sanitizeIdentifier(key)}` };
  }
  return { ...result, parsedOutput: parsed, gatedOutput: parsed };
}

class MonitorInfrastructureError extends Error {}

async function monitorSample(
  monitor: Phase1ResourceMonitor,
  session: { id: string },
  context: { phase: "before" | "after"; input: Phase1Input }
): Promise<Phase1ResourceSample> {
  try { return validateResourceSample(await monitor.sample(session, context), `monitor ${context.phase} resource sample`); }
  catch (error) { throw new MonitorInfrastructureError(`monitor ${context.phase} failed: ${errorMessage(error)}`); }
}

function monitorClassify(
  monitor: Phase1ResourceMonitor,
  samples: Phase1ResourceSample[]
): { status: "failed" | "stopped" | "oom"; errorCode: string } | undefined {
  try {
    for (const sample of samples) validateResourceSample(sample, "monitor classification resource sample");
    const classification = validateMonitorClassification(monitor.classify?.(samples));
    for (const sample of samples) validateResourceSample(sample, "monitor classification resource sample");
    return classification;
  }
  catch (error) { throw new MonitorInfrastructureError(`monitor classify failed: ${errorMessage(error)}`); }
}

function validateMonitorClassification(value: unknown): { status: "failed" | "stopped" | "oom"; errorCode: string } | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("monitor classification must be an object");
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "failed" && candidate.status !== "stopped" && candidate.status !== "oom") {
    throw new Error("monitor classification status is invalid");
  }
  if (typeof candidate.errorCode !== "string" || candidate.errorCode.length === 0) {
    throw new Error("monitor classification errorCode is invalid");
  }
  assertJsonValuesSecretSafe("monitor classification", candidate);
  return { status: candidate.status, errorCode: candidate.errorCode };
}

function validateMonitorSession(value: unknown): { id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("monitor session must be an object");
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).length !== 1 || !Object.prototype.hasOwnProperty.call(candidate, "id")) {
    throw new Error("monitor session shape is invalid");
  }
  assertJsonValuesSecretSafe("monitor session", candidate);
  const id = candidate.id;
  if (typeof id !== "string" || id.length === 0 || id.length > 128) throw new Error("monitor session id is invalid");
  assertSecretSafe("monitor session id", id);
  return { id };
}

async function finalizeMonitorEvidence(
  monitor: Phase1ResourceMonitor,
  session: { id: string },
  samples: Phase1ResourceSample[],
  attemptSamples: Phase1ResourceSample[],
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number]
): Promise<{
  infrastructureFailure?: string;
  terminalClassification?: { status: "failed" | "stopped" | "oom"; errorCode: string };
}> {
  let infrastructureFailure: string | undefined;
  let terminalClassification: { status: "failed" | "stopped" | "oom"; errorCode: string } | undefined;
  let classificationSamples = attemptSamples;
  try {
    const stopped = await monitor.stop(session);
    if (Array.isArray(stopped)) {
      if (stopped.length === 0) throw new Error("monitor terminal trace is empty");
      if (stopped.length > 16_384) throw new Error("monitor terminal trace exceeds the evidence sample cap");
      const validated = stopped.map((sample, index) => validateResourceSample(sample, `monitor stop resource sample ${index}`));
      classificationSamples = validated;
      const merged = mergeResourceSamples(samples, validated);
      if (merged.length > 16_384) throw new Error("combined reconstructed and terminal resource trace exceeds the evidence sample cap");
      samples.splice(0, samples.length, ...merged);
    } else {
      const terminal = validateResourceSample(stopped, "monitor stop resource sample");
      samples.push(terminal);
      classificationSamples = [...attemptSamples, terminal];
    }
  }
  catch (error) { infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `monitor stop failed: ${errorMessage(error)}`); }
  try {
    terminalClassification = monitorClassify(monitor, classificationSamples);
  } catch (error) {
    infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, errorMessage(error));
  }
  const resourceRecord = {
    schemaVersion: "neondiff-phase1-resources/v1",
    runFingerprint: manifest.runFingerprint,
    cellFingerprint: cell.fingerprint,
    monitorFingerprint: manifest.monitorFingerprint,
    samples,
    terminalClassification: terminalClassification ? {
      status: terminalClassification.status,
      errorCode: sanitizeIdentifier(terminalClassification.errorCode)
    } : undefined,
    terminalInfrastructureErrorCode: infrastructureFailure ? sanitizeIdentifier(infrastructureFailure) : undefined
  };
  try {
    for (const sample of resourceRecord.samples) validateResourceSample(sample, "persisted resource sample");
    assertJsonValuesSecretSafe("resource samples", resourceRecord.samples);
    atomicWriteJson(join(outputDir, "resources", `${cell.id}.json`), {
      ...resourceRecord,
      evidenceSha256: fingerprint(resourceRecord)
    });
  } catch (error) {
    infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `monitor evidence finalization failed: ${errorMessage(error)}`);
    try { writeResourceUnavailableFallback(outputDir, manifest, cell, infrastructureFailure); }
    catch (fallbackError) {
      infrastructureFailure = appendInfrastructureFailure(infrastructureFailure, `monitor evidence finalization and fallback write failed: ${errorMessage(fallbackError)}`);
    }
  }
  return { infrastructureFailure, terminalClassification };
}

function mergeResourceSamples(existing: Phase1ResourceSample[], terminal: Phase1ResourceSample[]): Phase1ResourceSample[] {
  const merged: Phase1ResourceSample[] = [];
  const seen = new Set<string>();
  for (const sample of [...existing, ...terminal]) {
    const identity = canonicalJson(sample);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(sample);
  }
  return merged;
}

function appendInfrastructureFailure(existing: string | undefined, next: string): string {
  const redacted = errorMessage(next).replace(/[\r\n]+/g, " ").trim().slice(0, 512) || "infrastructure_failure";
  if (!existing) return redacted;
  const separator = "; ";
  const prefixLength = Math.max(0, 2048 - separator.length - redacted.length);
  return `${existing.slice(0, prefixLength)}${separator}${redacted}`;
}

function writeResourceUnavailableFallback(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number],
  error: string
): void {
  const resourceRecord = {
    schemaVersion: "neondiff-phase1-resources/v1",
    runFingerprint: manifest.runFingerprint,
    cellFingerprint: cell.fingerprint,
    monitorFingerprint: manifest.monitorFingerprint,
    samples: [] as Phase1ResourceSample[],
    terminalInfrastructureErrorCode: sanitizeIdentifier(error),
    unavailable: true
  };
  atomicWriteJson(join(outputDir, `resource-unavailable-${cell.id}.json`), {
    ...resourceRecord,
    evidenceSha256: fingerprint(resourceRecord)
  });
}

function rewriteCellTerminalResults(
  outputDir: string,
  manifest: Manifest,
  cell: Manifest["cells"][number],
  terminal: { status: "failed" | "stopped" | "oom"; errorCode: string },
  preexistingResultPaths: ReadonlySet<string>
): void {
  for (const input of manifest.inputs) {
    const path = resultFile(outputDir, cell.id, input.id);
    if (!existsSync(path) || preexistingResultPaths.has(path)) continue;
    const record = parseJson<Record<string, unknown>>(path);
    if (record.status !== "completed") continue;
    const { evidenceSha256: _discarded, ...body } = record;
    const rewritten = {
      ...body,
      status: terminal.status,
      errorCode: sanitizeIdentifier(terminal.errorCode),
      residentTerminal: true,
      completedAt: new Date().toISOString()
    };
    assertResultPayloadSecretSafe(rewritten);
    atomicWriteJson(path, { ...rewritten, evidenceSha256: fingerprint(rewritten) });
  }
}

function numericMetadata(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function findInvalidMetric(metrics: Record<string, number> | undefined): string | undefined {
  if (!metrics) return undefined;
  for (const [name, value] of Object.entries(metrics)) {
    if (!Number.isFinite(value)) return name;
    if (isNonnegativeMetric(name) && value < 0) return name;
  }
  return undefined;
}

function isNonnegativeMetric(name: string): boolean {
  return /(?:ms|bytes|tokens?|count|duration|latency|throughput|perSecond|ttft|rss|vram|swap)$/i.test(name);
}

function validateResourceSample(value: unknown, label: string): Phase1ResourceSample {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const sample = value as Record<string, unknown>;
  if (typeof sample.capturedAt !== "string" || typeof sample.phase !== "string") {
    throw new Error(`${label} requires capturedAt and phase strings`);
  }
  for (const required of ["rssBytes", "vramBytes", "swapBytes"] as const) {
    if (typeof sample[required] !== "number" || !Number.isFinite(sample[required])) {
      throw new Error(`${label} field ${required} must be finite`);
    }
    if (sample[required] < 0) throw new Error(`${label} field ${required} must be nonnegative`);
  }
  for (const [name, field] of Object.entries(sample)) {
    if (typeof field !== "number") continue;
    if (!Number.isFinite(field)) throw new Error(`${label} field ${name} must be finite`);
    if (/(?:bytes|count|duration|ms|rss|vram|swap)$/i.test(name) && field < 0) {
      throw new Error(`${label} field ${name} must be nonnegative`);
    }
  }
  return value as Phase1ResourceSample;
}

function assertUniqueSafeIds(kind: string, ids: string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${kind} IDs must be unique`);
  for (const id of ids) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) throw new Error(`${kind} ID is not path safe: ${id}`);
}

function assertSecretSafe(label: string, value: string): void {
  if (containsSecretLikeText(value)) throw new Error(`${label} contains secret-like text and cannot enter Phase 1 evidence`);
}

function assertJsonValuesSecretSafe(label: string, value: unknown): void {
  if (typeof value === "string") {
    if (containsSecretLikeText(value)) throw new Error(`${label} contains secret-like text in a value: ${redactSecrets(value)}`);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertJsonValuesSecretSafe(label, item); return; }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertSecretSafe(`${label} key`, key);
      assertJsonValuesSecretSafe(label, item);
    }
  }
}

function assertManifestPayloadSecretSafe(spec: Phase1RunSpec): void {
  // Protocol versions and runner-generated digests are validated by
  // validateSpec/buildManifest. Only payload-bearing positions are passed to
  // the recursive free-text scanner, so an identically named key inside
  // untrusted metadata receives no exemption.
  assertJsonValuesSecretSafe("target executable arguments", spec.target.args);
  assertJsonValuesSecretSafe("target serving metadata", spec.target.servingParameters);
  assertJsonValuesSecretSafe("prompt template", spec.prompt.template);
  assertJsonValuesSecretSafe("prompt metadata", spec.prompt.parameters);
  assertJsonValuesSecretSafe("request response format", spec.request.responseFormat);
  assertJsonValuesSecretSafe("request metadata", spec.request.parameters);
  assertJsonValuesSecretSafe("required metric names", spec.request.requiredMetrics);
  assertJsonValuesSecretSafe("gate key names", spec.gate.requiredTopLevelKeys);
  assertSecretSafe("harness source path", spec.harness.sourcePath);
  assertSecretSafe("harness entrypoint path", spec.harness.entrypointPath);
  assertSecretSafe("harness runner path", spec.harness.runnerPath);
  for (const cell of spec.cells) {
    assertSecretSafe("cell identifier", cell.id);
    assertJsonValuesSecretSafe(`cell ${cell.id} executable arguments`, cell.executableArgs);
    assertJsonValuesSecretSafe(`cell ${cell.id} metadata`, cell.parameters);
    assertJsonValuesSecretSafe(`cell ${cell.id} placement policy`, cell.placement);
  }
  for (const input of spec.inputs) {
    assertSecretSafe("input identifier", input.id);
    assertJsonValuesSecretSafe(`input ${input.id} metadata`, input.metadata);
  }
}

function assertProtocolVersion(label: string, version: string): void {
  if (!/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*\/v[1-9][0-9]*$/.test(version)) {
    throw new Error(`${label} protocol version is invalid`);
  }
  assertSecretSafe(`${label} protocol version`, version);
}

function assertResultPayloadSecretSafe(record: Record<string, unknown>): void {
  for (const key of ["rawOutput", "parsedOutput", "gatedOutput", "metrics", "errorCode", "resourceSamples"]) {
    assertJsonValuesSecretSafe(`result ${key}`, record[key]);
  }
}

function assertTerminalStatus(value: unknown): asserts value is Phase1TerminalStatus {
  if (!isTerminalStatus(value)) throw new Error(`adapter returned non-terminal status: ${String(value)}`);
}

function isTerminalStatus(value: unknown): value is Phase1TerminalStatus {
  return value === "completed" || value === "failed" || value === "stopped" || value === "oom" || value === "schema_failed";
}

function resultFile(outputDir: string, cellId: string, inputId: string): string {
  return join(outputDir, "results", cellId, `${inputId}.json`);
}

function atomicWriteJson(path: string, value: unknown): void {
  atomicWriteText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicCreateJson(path: string, value: unknown): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
    linkSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function atomicWriteText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function finalizeRun(outputDir: string, summary: Phase1RunSummary): Phase1RunSummary {
  atomicWriteJson(join(outputDir, "summary.json"), summary);
  rmSync(join(outputDir, "RUNNING"), { force: true });
  const marker = summary.status === "completed" ? "COMPLETED" : "FAILED";
  rmSync(join(outputDir, marker === "COMPLETED" ? "FAILED" : "COMPLETED"), { force: true });
  atomicWriteText(join(outputDir, marker), `${summary.summarySha256}\n`);
  return summary;
}

function parseJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function fingerprint(value: unknown): string {
  return sha256(canonicalJson(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sortJson(item)]));
  }
  return value;
}

function safeErrorCode(error: unknown): string {
  return sanitizeIdentifier(error instanceof Error ? error.name : "invocation_failed");
}

function errorMessage(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function sanitizeIdentifier(value: string): string {
  return redactSecrets(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 128) || "failed";
}

function minimalProcessEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "LD_LIBRARY_PATH", "CUDA_VISIBLE_DEVICES"] as const;
  return Object.fromEntries(allowed
    .map((key) => [key, process.env[key]])
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function waitForHealthy(baseUrl: string, timeoutMs: number, state: ResidentProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.unsafeEvidence) throw new Error("llama-server emitted secret-like text during startup");
    if (state.exited) throw new Error(`llama-server exited before readiness: ${state.stderrTail || "no redacted diagnostics"}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // Expected while the resident loads its model.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("llama-server readiness timeout");
}

async function stopProcess(state: ResidentProcess, timeoutMs: number): Promise<void> {
  if (state.exited) return;
  signalProcessGroup(state.process.pid, "SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => state.process.once("exit", () => resolve(true))),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
  if (!exited && !state.exited) {
    signalProcessGroup(state.process.pid, "SIGKILL");
    const killed = await Promise.race([
      new Promise<boolean>((resolve) => state.process.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs))
    ]);
    if (!killed && !state.exited) throw new Error("resident process-group cleanup could not be proven after SIGKILL");
  }
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already stopped */ } }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EPERM"; }
}

async function recoverResidentJournal(
  path: string,
  executableSha256: string,
  verifyProcessIdentity: NonNullable<LlamaServerExecutableAdapterOptions["verifyProcessIdentity"]>,
  stopTimeoutMs: number
): Promise<void> {
  if (!existsSync(path)) return;
  const journal = parseJson<{ state?: string; pid?: number; executableSha256?: string; argvFingerprint?: string }>(path);
  if (journal.state !== "running" || typeof journal.pid !== "number" || !isProcessAlive(journal.pid)) return;
  if (journal.executableSha256 !== executableSha256 || typeof journal.argvFingerprint !== "string"
    || !await verifyProcessIdentity(journal.pid, executableSha256, journal.argvFingerprint)) {
    throw new Error("existing resident journal points to an unverified live process; refusing recovery");
  }
  signalProcessGroup(journal.pid, "SIGTERM");
  const deadline = Date.now() + stopTimeoutMs;
  while (isProcessAlive(journal.pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  if (isProcessAlive(journal.pid)) {
    signalProcessGroup(journal.pid, "SIGKILL");
    const killDeadline = Date.now() + stopTimeoutMs;
    while (isProcessAlive(journal.pid) && Date.now() < killDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (isProcessAlive(journal.pid)) throw new Error("stale resident recovery could not be proven after SIGKILL");
  }
  atomicWriteJson(path, { ...journal, state: "recovered_stopped", recoveredAt: new Date().toISOString() });
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function gitCommitContainsBytes(checkoutRoot: string, commit: string, relativePath: string, expectedSha256: string): boolean {
  if (!/^[a-f0-9]{40}$/.test(commit) || relativePath.includes("\0") || relativePath.includes(":") || relativePath.includes("\\")
    || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  try {
    const bytes = execFileSync("git", ["-C", checkoutRoot, "show", `${commit}:${relativePath}`], {
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return sha256(bytes) === expectedSha256;
  } catch {
    return false;
  }
}

async function verifyResourceMonitorModuleIdentity(identity: Phase1ResourceMonitorModule): Promise<void> {
  const { modulePath, approvedRoot, moduleSha256, exportName, factoryParameters } = identity;
  assertProtocolVersion("resource monitor", identity.version);
  assertJsonValuesSecretSafe("resource monitor paths", [modulePath, approvedRoot, exportName]);
  if (resolve(modulePath) !== modulePath || resolve(approvedRoot) !== approvedRoot) {
    throw new Error("resource monitor source and approved root paths must be absolute");
  }
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,127}$/.test(exportName)) throw new Error("resource monitor export name is invalid");
  if (factoryParameters !== undefined) {
    if (!factoryParameters || typeof factoryParameters !== "object" || Array.isArray(factoryParameters) || Object.keys(factoryParameters).length > 32) {
      throw new Error("resource monitor factory parameters are invalid");
    }
    for (const [key, value] of Object.entries(factoryParameters)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) || typeof value !== "string" || value.length > 512) {
        throw new Error("resource monitor factory parameters are invalid");
      }
    }
    assertJsonValuesSecretSafe("resource monitor factory parameters", factoryParameters);
  }
  const source = realpathSync(modulePath);
  const root = realpathSync(approvedRoot);
  if (source !== root && !source.startsWith(`${root}${sep}`)) throw new Error("resource monitor source must be inside its approved boundary");
  if (await sha256File(source) !== moduleSha256) throw new Error("resource monitor source SHA-256 does not match its immutable identity");
  assertMonitorModuleImportsAreLoadable(readFileSync(source, "utf8"));
}

async function loadResourceMonitorModule(identity: Phase1ResourceMonitorModule): Promise<Phase1ResourceMonitor> {
  await verifyResourceMonitorModuleIdentity(identity);
  const bytes = readFileSync(realpathSync(identity.modulePath));
  if (sha256(bytes) !== identity.moduleSha256) throw new Error("resource monitor module changed before exact-byte loading");
  // Import the verified bytes themselves, rather than re-opening the path via
  // the module loader. This closes the hash-check/import TOCTOU window and
  // ensures the executing factory is exactly the artifact named in evidence.
  // The nonce is deliberately run-local and excluded from evidence identity.
  // Node caches ESM namespaces by URL; a unique fragment ensures module-scope
  // counters cannot leak between candidates or repeated runPhase1Screen calls.
  const moduleUrl = `data:text/javascript;base64,${bytes.toString("base64")}#sha256=${identity.moduleSha256}&load=${randomUUID()}`;
  const loaded = await import(moduleUrl) as Record<string, unknown>;
  const factory = loaded[identity.exportName];
  if (typeof factory !== "function") throw new Error("resource monitor module does not export the pinned factory");
  const factoryParameters = Object.freeze({ ...(identity.factoryParameters ?? {}) });
  const monitor = await (factory as (parameters: Readonly<Record<string, string>>) => unknown)(factoryParameters);
  if (!monitor || typeof monitor !== "object") throw new Error("resource monitor factory did not return an object");
  const candidate = monitor as Partial<Phase1ResourceMonitor>;
  if (typeof candidate.start !== "function" || typeof candidate.sample !== "function" || typeof candidate.stop !== "function"
    || (candidate.attach !== undefined && typeof candidate.attach !== "function")
    || (candidate.classify !== undefined && typeof candidate.classify !== "function")) {
    throw new Error("resource monitor factory returned an invalid monitor implementation");
  }
  return candidate as Phase1ResourceMonitor;
}

function assertMonitorModuleImportsAreLoadable(source: string): void {
  const lexicalSource = stripJavaScriptComments(source);
  if (/\bimport\s*\(/.test(lexicalSource)) {
    throw new Error("resource monitor module must be self-contained; dynamic import syntax is forbidden");
  }
  if (/\bprocess\s*\.\s*getBuiltinModule\b/.test(lexicalSource) || /\brequire\s*\(/.test(lexicalSource)) {
    throw new Error("resource monitor module must be self-contained; runtime module-loading escape hatch is forbidden");
  }
  const specifiers: string[] = [];
  for (const pattern of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*["']([^"']+)["']/g]) {
    for (const match of lexicalSource.matchAll(pattern)) specifiers.push(match[1]);
  }
  const unsupported = specifiers.find((specifier) => !specifier.startsWith("node:"));
  if (unsupported) {
    throw new Error(`resource monitor module must be self-contained; unsupported import specifier: ${sanitizeIdentifier(unsupported)}`);
  }
  const moduleLoadingEscape = specifiers.find((specifier) => specifier === "node:module" || specifier === "node:vm" || specifier === "node:worker_threads");
  if (moduleLoadingEscape) {
    throw new Error(`resource monitor module must be self-contained; module-loading escape hatch is forbidden: ${sanitizeIdentifier(moduleLoadingEscape)}`);
  }
}

function stripJavaScriptComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index];
    const next = source[index + 1];
    if (quote) {
      output += current;
      if (current === "\\") {
        output += next ?? "";
        index += 1;
      } else if (current === quote) quote = undefined;
      continue;
    }
    if (current === "'" || current === '"' || current === "`") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 1;
      output += " ";
      continue;
    }
    output += current;
  }
  return output;
}

async function readResponseBody(response: Response, maximumBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("llama-server response exceeds evidence byte cap");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let used = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    used += value.byteLength;
    if (used > maximumBytes) {
      await reader.cancel();
      throw new Error("llama-server response exceeds evidence byte cap");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

async function readStreamingAssistant(
  response: Response,
  maximumBytes: number,
  requestStartedAt: number
): Promise<{ content: string; metrics: Record<string, number> }> {
  if (!response.body) throw new Error("llama-server streaming response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let content = "";
  let used = 0;
  let ttftMs: number | undefined;
  const terminalMetrics: Record<string, number> = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    used += value.byteLength;
    if (used > maximumBytes) {
      await reader.cancel();
      throw new Error("llama-server streaming response exceeds evidence byte cap");
    }
    buffered += decoder.decode(value, { stream: true });
    const events = buffered.split(/\r?\n\r?\n/);
    buffered = events.pop() ?? "";
    for (const event of events) {
      for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let envelope: unknown;
        try { envelope = JSON.parse(data); }
        catch { throw new Error("invalid llama-server streaming envelope"); }
        const envelopeMetrics = readResponseMetrics(envelope, 0);
        delete envelopeMetrics.latencyMs;
        Object.assign(terminalMetrics, envelopeMetrics);
        const delta = readDeltaContent(envelope);
        if (delta) {
          if (ttftMs === undefined) ttftMs = Math.max(0, performance.now() - requestStartedAt);
          content += delta;
        }
      }
    }
  }
  if (buffered.trim() && !buffered.includes("[DONE]")) throw new Error("truncated llama-server streaming response");
  if (!content) throw new Error("llama-server streaming response contained no assistant content");
  return {
    content,
    metrics: {
      ...terminalMetrics,
      latencyMs: Math.max(0, performance.now() - requestStartedAt),
      ttftMs: ttftMs ?? 0,
      responseBytes: Buffer.byteLength(content, "utf8")
    }
  };
}

function readDeltaContent(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined;
  const delta = (choices[0] as { delta?: unknown }).delta;
  if (!delta || typeof delta !== "object") return undefined;
  const content = (delta as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function classifyExitedResident(state: ResidentProcess): Phase1InvocationResult {
  const diagnostics = state.stderrTail.toLowerCase();
  return /out of memory|cuda.*alloc|oom/.test(diagnostics)
    ? { status: "oom", errorCode: "resident_oom", residentTerminal: true, retryCount: 0 }
    : { status: "stopped", errorCode: "resident_exited", residentTerminal: true, retryCount: 0 };
}

function readAssistantContent(envelope: unknown): string | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return undefined;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

function readResponseMetrics(envelope: unknown, latencyMs: number): Record<string, number> {
  const metrics: Record<string, number> = { latencyMs: Math.max(0, latencyMs) };
  if (!envelope || typeof envelope !== "object") return metrics;
  const usage = (envelope as { usage?: unknown }).usage;
  if (usage && typeof usage === "object") {
    for (const [source, target] of [
      ["prompt_tokens", "promptTokens"],
      ["completion_tokens", "completionTokens"],
      ["total_tokens", "totalTokens"]
    ] as const) {
      const value = (usage as Record<string, unknown>)[source];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) metrics[target] = value;
    }
  }
  const timings = (envelope as { timings?: unknown }).timings;
  if (timings && typeof timings === "object") {
    for (const [source, target] of [
      ["prompt_ms", "promptMs"],
      ["predicted_ms", "decodeMs"],
      ["prompt_per_second", "promptTokensPerSecond"],
      ["predicted_per_second", "decodeTokensPerSecond"]
    ] as const) {
      const value = (timings as Record<string, unknown>)[source];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) metrics[target] = value;
    }
  }
  return metrics;
}

function hasFlagValue(args: string[], flag: string, expected: string): boolean {
  const index = args.lastIndexOf(flag);
  return index >= 0 && args[index + 1] === expected;
}

function readGpuLayerRequest(args: string[]): number | "all" {
  const aliases = new Set(["-ngl", "--n-gpu-layers", "--gpu-layers"]);
  const matches = args.flatMap((arg, index) => aliases.has(arg) ? [args[index + 1]] : []);
  if (matches.length !== 1 || matches[0] === undefined) throw new Error("llama-server placement requires exactly one GPU-layer argument");
  if (matches[0] === "all") return "all";
  const value = Number(matches[0]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("llama-server GPU-layer argument is invalid");
  return value;
}

function readCpuMoeRequest(args: string[]): { kind: "all" } | { kind: "first_n"; count: number } | undefined {
  const allAliases = new Set(["-cmoe", "--cpu-moe"]);
  const rangeAliases = new Set(["-ncmoe", "--n-cpu-moe"]);
  const requests: Array<{ kind: "all" } | { kind: "first_n"; count: number }> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (allAliases.has(args[index])) requests.push({ kind: "all" });
    if (rangeAliases.has(args[index])) {
      const count = Number(args[index + 1]);
      if (!Number.isSafeInteger(count) || count <= 0) throw new Error("llama-server ranged CPU-MoE argument is invalid");
      requests.push({ kind: "first_n", count });
    }
  }
  if (requests.length > 1) throw new Error("llama-server CPU-MoE arguments conflict or are duplicated");
  return requests[0];
}

function assertPlacementDebugVerbosity(args: string[]): void {
  const verboseAliases = new Set(["-v", "--verbose", "--log-verbose"]);
  const numericAliases = new Set(["-lv", "--verbosity", "--log-verbosity"]);
  const forms: Array<{ kind: "verbose" } | { kind: "numeric"; value: number }> = [];
  for (let index = 0; index < args.length; index += 1) {
    if (verboseAliases.has(args[index])) forms.push({ kind: "verbose" });
    if (numericAliases.has(args[index])) {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value)) throw new Error("llama-server placement log verbosity is invalid");
      forms.push({ kind: "numeric", value });
    }
  }
  if (forms.length !== 1 || (forms[0].kind === "numeric" && forms[0].value < 5)) {
    throw new Error("llama-server placement requires exactly one debug-enabling verbosity argument");
  }
}

async function assertEndpointUnbound(host: string, port: number): Promise<void> {
  const occupied = await new Promise<boolean>((resolve) => {
    const socket = connect({ host, port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
  if (occupied) throw new Error("llama-server endpoint already has a listener; refusing unowned resident endpoint");
}
