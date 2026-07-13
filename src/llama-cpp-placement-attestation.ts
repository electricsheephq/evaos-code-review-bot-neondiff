import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

export type LlamaCppStartupStream = "stdout" | "stderr";

export interface LlamaCppStartupEvent {
  sequence: number;
  stream: LlamaCppStartupStream;
  line: string;
}

export interface LlamaCppStartupSource {
  schemaVersion: "neondiff-llama-cpp-startup-source/v1";
  events: LlamaCppStartupEvent[];
  capturedBytes: number;
  capturedLines: number;
  truncated: boolean;
  sha256: string;
}

export interface LlamaCppStartupChunk {
  stream: LlamaCppStartupStream;
  chunk: Buffer;
}

export interface LlamaCppStartupCaptureOptions {
  maxBytes: number;
  maxLines: number;
}

export interface LlamaCppStartupCapture {
  push(chunk: LlamaCppStartupChunk): void;
  finalize(): LlamaCppStartupSource;
}

export type LlamaCppPlacementProfile = "full_gpu" | "partial_gpu" | "all_plus_cpu_moe";

export interface LlamaCppPlacementRequirement {
  backendCommit: string;
  profile: LlamaCppPlacementProfile;
  requestedGpuLayers: number | "all";
  expectedCpuMoe?: {
    requestKind: "all" | "first_n";
    firstLayer: number;
    lastLayer: number;
    layerCount: number;
    minimumMatchedTensors: number;
  };
}

export interface LlamaCppPlacementReceipt {
  schemaVersion: "neondiff-llama-cpp-placement/v1";
  parser: { version: "llama.cpp-b9977-placement/v1"; backendCommit: string };
  requestedGpuLayers: number | "all";
  observedGpuLayers: number;
  totalModelLayers: number;
  repeatingGpuLayers: number;
  outputLayerOffloaded: boolean;
  layerAssignments: Array<{ layer: number; device: string; isSwa: boolean }>;
  modelBuffers: Array<{ device: string; mib: number }>;
  kv: {
    layerAssignments: Array<{ layer: number; device: string }>;
    buffers: Array<{ device: string; mib: number }>;
    types: { k: string; v: string };
  };
  outputBuffers: Array<{ device: string; mib: number }>;
  recurrentState: {
    layerAssignments: Array<{ layer: number; device: string }>;
    buffers: Array<{ device: string; mib: number }>;
  };
  computeBuffers: Array<{ device: string; mib: number }>;
  cpuExpertOverrides?: {
    device: "CPU";
    requestKind: "all" | "first_n";
    affectedLayerRanges: Array<{ firstLayer: number; lastLayer: number }>;
    affectedLayerCount: number;
    matchedTensorCount: number;
  };
  contradictions: string[];
  source: Omit<LlamaCppStartupSource, "events"> & { eventCount: number };
}

const KNOWN_B9977_COMMITS = new Set([
  "b9977",
  "6b4dc2116a92c5c8f2782bfe51fabe5ee66fb5ef"
]);

export const LLAMA_CPP_STARTUP_MAX_BYTES = 8 * 1024 * 1024;
export const LLAMA_CPP_STARTUP_MAX_LINES = 16_384;
export const LLAMA_CPP_STARTUP_MAX_LINE_CHARS = 8_192;

const DEVICE = "([A-Za-z0-9_.:-]+)";
const NUMBER = "([0-9]+(?:\\.[0-9]+)?)";
const LAYER_ASSIGNMENT = new RegExp(`^load_tensors:\\s+layer\\s+(\\d+)\\s+assigned to device\\s+${DEVICE},\\s+is_swa\\s*=\\s*([01])\\s*$`);
const OUTPUT_OFFLOAD = /^load_tensors:\s+offloading output layer to GPU\s*$/;
const REPEATING_OFFLOAD = /^load_tensors:\s+offloading\s+(\d+)\s+repeating layers to GPU\s*$/;
const TOTAL_OFFLOAD = /^load_tensors:\s+offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers to GPU\s*$/;
const MODEL_BUFFER = new RegExp(`^load_tensors:\\s+${DEVICE}\\s+model buffer size\\s*=\\s*${NUMBER}\\s+MiB\\s*$`);
const KV_LAYER = new RegExp(`^llama_kv_cache(?:_unified)?:\\s+layer\\s+(\\d+):\\s+dev\\s*=\\s*${DEVICE}\\s*$`);
const KV_BUFFER = new RegExp(`^llama_kv_cache(?:_unified)?:\\s+${DEVICE}\\s+KV buffer size\\s*=\\s*${NUMBER}\\s+MiB\\s*$`);
const KV_TYPES = /^llama_kv_cache(?:_unified)?:\s+size\s*=.*\bK\s+\(([A-Za-z0-9_.:-]+)\):.*\bV\s+\(([A-Za-z0-9_.:-]+)\):.*$/;
const OUTPUT_BUFFER = new RegExp(`^llama_context:\\s+${DEVICE}\\s+output buffer size\\s*=\\s*${NUMBER}\\s+MiB\\s*$`);
const RECURRENT_LAYER = new RegExp(`^llama_memory_recurrent,\\s+layer\\s+(\\d+):\\s+dev\\s*=\\s*${DEVICE}\\s*$`);
const RECURRENT_BUFFER = new RegExp(`^llama_memory_recurrent:\\s+${DEVICE}\\s+RS buffer size\\s*=\\s*${NUMBER}\\s+MiB\\s*$`);
const COMPUTE_BUFFER = new RegExp(`^(?:sched_reserve|~llama_context):\\s+${DEVICE}\\s+compute buffer size\\s+(?:=|is)\\s+${NUMBER}\\s+MiB(?:,\\s+matches expectation of\\s+[0-9]+(?:\\.[0-9]+)?\\s+MiB)?\\s*$`);
const CPU_EXPERT_OVERRIDE = /^tensor\s+(blk\.(\d+)\.ffn_(?:up|down|gate|gate_up)_(?:ch)?exps(?:\.[A-Za-z0-9_.-]+)?)\s+\((\d+)\s+MiB\s+[A-Za-z0-9_.:-]+\)\s+buffer type overridden to\s+(CPU[A-Za-z0-9_.:-]*)\s*$/;

export function llamaCppPlacementAttestationModulePath(): string {
  return fileURLToPath(import.meta.url);
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

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function placementRelevantLine(line: string): boolean {
  return [
    LAYER_ASSIGNMENT,
    OUTPUT_OFFLOAD,
    REPEATING_OFFLOAD,
    TOTAL_OFFLOAD,
    MODEL_BUFFER,
    KV_LAYER,
    KV_BUFFER,
    KV_TYPES,
    OUTPUT_BUFFER,
    RECURRENT_LAYER,
    RECURRENT_BUFFER,
    COMPUTE_BUFFER,
    CPU_EXPERT_OVERRIDE
  ].some((pattern) => pattern.test(line));
}

export function captureLlamaCppStartup(
  chunks: readonly LlamaCppStartupChunk[],
  options: LlamaCppStartupCaptureOptions
): LlamaCppStartupSource {
  const capture = createLlamaCppStartupCapture(options);
  for (const chunk of chunks) capture.push(chunk);
  return capture.finalize();
}

export function createLlamaCppStartupCapture(
  options: LlamaCppStartupCaptureOptions
): LlamaCppStartupCapture {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0
    || !Number.isSafeInteger(options.maxLines) || options.maxLines <= 0) {
    throw new Error("llama.cpp startup capture limits must be positive integers");
  }
  if (options.maxBytes > LLAMA_CPP_STARTUP_MAX_BYTES || options.maxLines > LLAMA_CPP_STARTUP_MAX_LINES) {
    throw new Error("llama.cpp startup capture exceeds the implementation maximum");
  }
  const decoders = {
    stdout: new TextDecoder("utf-8", { fatal: true }),
    stderr: new TextDecoder("utf-8", { fatal: true })
  };
  const pending = { stdout: "", stderr: "" };
  const secretTail = { stdout: "", stderr: "" };
  const events: LlamaCppStartupEvent[] = [];
  let capturedBytes = 0;
  let truncated = false;
  let finalized = false;
  let rejected = false;

  const reject = (error: unknown): never => {
    rejected = true;
    throw error;
  };

  const scanSecretText = (stream: LlamaCppStartupStream, text: string): void => {
    const candidate = `${secretTail[stream]}${text}`;
    if (containsSecretLikeText(candidate)) reject(new Error("llama.cpp startup output contains secret-like text"));
    secretTail[stream] = candidate.slice(-512);
  };

  const consumeText = (stream: LlamaCppStartupStream, text: string): void => {
    pending[stream] += text;
    const lines = pending[stream].split("\n");
    pending[stream] = lines.pop() ?? "";
    if (pending[stream].length > LLAMA_CPP_STARTUP_MAX_LINE_CHARS) {
      reject(new Error("llama.cpp startup line exceeds the implementation line limit"));
    }
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, "");
      if (line.length > LLAMA_CPP_STARTUP_MAX_LINE_CHARS) {
        reject(new Error("llama.cpp startup line exceeds the implementation line limit"));
      }
      if (!placementRelevantLine(line)) continue;
      if (events.length >= options.maxLines) {
        truncated = true;
        continue;
      }
      events.push({
        sequence: events.length,
        stream,
        line: redactSecrets(line)
      });
    }
  };

  return {
    push({ stream, chunk }): void {
      if (finalized || rejected) throw new Error("llama.cpp startup capture is finalized or rejected");
      if (stream !== "stdout" && stream !== "stderr") reject(new Error("llama.cpp startup stream is invalid"));
      if (!Buffer.isBuffer(chunk)) reject(new Error("llama.cpp startup chunk must be bytes"));
      scanSecretText(stream, chunk.toString("latin1"));
      const remaining = options.maxBytes - capturedBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      capturedBytes += accepted.length;
      if (accepted.length < chunk.length) truncated = true;
      try {
        consumeText(stream, decoders[stream].decode(accepted, { stream: true }));
      } catch (error) {
        reject(error);
      }
    },
    finalize(): LlamaCppStartupSource {
      if (finalized || rejected) throw new Error("llama.cpp startup capture is finalized or rejected");
      finalized = true;
      for (const stream of ["stdout", "stderr"] as const) {
        try {
          consumeText(stream, decoders[stream].decode());
        } catch (error) {
          return reject(error);
        }
        if (pending[stream]) {
          if (events.length >= options.maxLines) truncated = true;
          else if (placementRelevantLine(pending[stream])) events.push({ sequence: events.length, stream, line: redactSecrets(pending[stream]) });
        }
      }
      const identity = {
        schemaVersion: "neondiff-llama-cpp-startup-source/v1" as const,
        events,
        capturedBytes,
        capturedLines: events.length,
        truncated
      };
      return { ...identity, sha256: digest(identity) };
    }
  };
}

function uniqueNumber(name: string, matches: number[]): number {
  if (matches.length !== 1) throw new Error(`llama.cpp placement requires exactly one ${name} record`);
  return matches[0];
}

function parseMib(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("llama.cpp placement buffer size is invalid");
  return parsed;
}

function rejectDuplicateLayers(items: Array<{ layer: number }>, label: string): void {
  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.layer)) throw new Error(`duplicate llama.cpp ${label} layer record`);
    seen.add(item.layer);
  }
}

function contiguousRanges(layers: number[]): Array<{ firstLayer: number; lastLayer: number }> {
  if (layers.length === 0) return [];
  const ranges: Array<{ firstLayer: number; lastLayer: number }> = [];
  let firstLayer = layers[0];
  let lastLayer = layers[0];
  for (const layer of layers.slice(1)) {
    if (layer === lastLayer + 1) lastLayer = layer;
    else {
      ranges.push({ firstLayer, lastLayer });
      firstLayer = layer;
      lastLayer = layer;
    }
  }
  ranges.push({ firstLayer, lastLayer });
  return ranges;
}

export function parseLlamaCppPlacementAttestation(
  source: LlamaCppStartupSource,
  requirement: LlamaCppPlacementRequirement
): LlamaCppPlacementReceipt {
  if (!(["full_gpu", "partial_gpu", "all_plus_cpu_moe"] as string[]).includes(requirement.profile)) {
    throw new Error("llama.cpp placement profile is unsupported");
  }
  if (requirement.profile === "all_plus_cpu_moe") {
    if (!requirement.expectedCpuMoe
      || !(["all", "first_n"] as string[]).includes(requirement.expectedCpuMoe.requestKind)) {
      throw new Error("llama.cpp CPU-MoE request kind is unsupported");
    }
  } else if (requirement.expectedCpuMoe !== undefined) {
    throw new Error("llama.cpp placement has an unexpected CPU-MoE contract");
  }
  if (!KNOWN_B9977_COMMITS.has(requirement.backendCommit)) {
    throw new Error("llama.cpp placement parser does not recognize this backend variant");
  }
  const { sha256, ...sourceIdentity } = source;
  if (sha256 !== digest(sourceIdentity)) throw new Error("llama.cpp startup source fingerprint mismatch");
  if (source.schemaVersion !== "neondiff-llama-cpp-startup-source/v1"
    || source.capturedLines !== source.events.length
    || source.events.some((event, index) => event.sequence !== index)) {
    throw new Error("llama.cpp startup source sequence is invalid");
  }
  if (source.truncated) throw new Error("llama.cpp startup capture is truncated");

  const layerAssignments: LlamaCppPlacementReceipt["layerAssignments"] = [];
  const modelBuffers: LlamaCppPlacementReceipt["modelBuffers"] = [];
  const kvLayerAssignments: LlamaCppPlacementReceipt["kv"]["layerAssignments"] = [];
  const kvBuffers: LlamaCppPlacementReceipt["kv"]["buffers"] = [];
  const kvTypes: Array<{ k: string; v: string }> = [];
  const outputBuffers: LlamaCppPlacementReceipt["outputBuffers"] = [];
  const recurrentLayerAssignments: LlamaCppPlacementReceipt["recurrentState"]["layerAssignments"] = [];
  const recurrentBuffers: LlamaCppPlacementReceipt["recurrentState"]["buffers"] = [];
  const computeBuffers: LlamaCppPlacementReceipt["computeBuffers"] = [];
  const cpuExpertTensors: Array<{ name: string; layer: number; device: string }> = [];
  const repeating: number[] = [];
  const totals: Array<{ observed: number; total: number }> = [];
  let outputLayerOffloaded = false;

  for (const { line } of source.events) {
    let match: RegExpExecArray | null;
    if ((match = LAYER_ASSIGNMENT.exec(line))) {
      layerAssignments.push({ layer: Number(match[1]), device: match[2], isSwa: match[3] === "1" });
    } else if (OUTPUT_OFFLOAD.test(line)) {
      if (outputLayerOffloaded) throw new Error("duplicate llama.cpp output-layer placement record");
      outputLayerOffloaded = true;
    } else if ((match = REPEATING_OFFLOAD.exec(line))) {
      repeating.push(Number(match[1]));
    } else if ((match = TOTAL_OFFLOAD.exec(line))) {
      totals.push({ observed: Number(match[1]), total: Number(match[2]) });
    } else if ((match = MODEL_BUFFER.exec(line))) {
      modelBuffers.push({ device: match[1], mib: parseMib(match[2]) });
    } else if ((match = KV_LAYER.exec(line))) {
      kvLayerAssignments.push({ layer: Number(match[1]), device: match[2] });
    } else if ((match = KV_BUFFER.exec(line))) {
      kvBuffers.push({ device: match[1], mib: parseMib(match[2]) });
    } else if ((match = KV_TYPES.exec(line))) {
      kvTypes.push({ k: match[1], v: match[2] });
    } else if ((match = OUTPUT_BUFFER.exec(line))) {
      outputBuffers.push({ device: match[1], mib: parseMib(match[2]) });
    } else if ((match = RECURRENT_LAYER.exec(line))) {
      recurrentLayerAssignments.push({ layer: Number(match[1]), device: match[2] });
    } else if ((match = RECURRENT_BUFFER.exec(line))) {
      recurrentBuffers.push({ device: match[1], mib: parseMib(match[2]) });
    } else if ((match = COMPUTE_BUFFER.exec(line))) {
      computeBuffers.push({ device: match[1], mib: parseMib(match[2]) });
    } else if ((match = CPU_EXPERT_OVERRIDE.exec(line))) {
      cpuExpertTensors.push({ name: match[1], layer: Number(match[2]), device: match[4] });
    }
  }

  const repeatingGpuLayers = uniqueNumber("repeating-layer", repeating);
  const total = totals.length === 1 ? totals[0] : undefined;
  if (!total) throw new Error("llama.cpp placement requires exactly one total GPU offload record");
  rejectDuplicateLayers(layerAssignments, "model assignment");
  rejectDuplicateLayers(kvLayerAssignments, "KV assignment");
  rejectDuplicateLayers(recurrentLayerAssignments, "recurrent assignment");
  if (new Set(cpuExpertTensors.map((tensor) => tensor.name)).size !== cpuExpertTensors.length) {
    throw new Error("duplicate llama.cpp CPU expert tensor override record");
  }
  const contradictions: string[] = [];
  if (repeatingGpuLayers + (outputLayerOffloaded ? 1 : 0) !== total.observed) contradictions.push("GPU offload totals disagree");
  const gpuAssignments = layerAssignments.filter((item) => !item.device.startsWith("CPU")).length;
  const cpuAssignments = layerAssignments.length - gpuAssignments;
  if (layerAssignments.length !== total.total || gpuAssignments !== total.observed) contradictions.push("layer assignments disagree with GPU offload totals");
  if (requirement.profile === "partial_gpu") {
    if (typeof requirement.requestedGpuLayers !== "number" || total.observed !== requirement.requestedGpuLayers) contradictions.push("partial-GPU observed layers differ from the literal request");
    if (total.observed >= total.total || cpuAssignments === 0 || gpuAssignments === 0) contradictions.push("partial-GPU profile is not partially offloaded");
  } else {
    if (total.observed !== total.total || cpuAssignments !== 0 || !outputLayerOffloaded) contradictions.push("full-GPU profile is not fully offloaded");
    if (typeof requirement.requestedGpuLayers === "number" && requirement.requestedGpuLayers < total.total) contradictions.push("full-GPU literal request is smaller than the model layer count");
  }
  if (contradictions.length > 0) throw new Error(`contradictory llama.cpp placement evidence: ${contradictions.join("; ")}`);
  if (modelBuffers.length === 0 || kvBuffers.length === 0 || computeBuffers.length === 0) {
    throw new Error("llama.cpp placement is missing required buffer evidence");
  }
  if (kvTypes.length !== 1) throw new Error("llama.cpp placement requires exactly one KV cache type record");
  let cpuExpertOverrides: LlamaCppPlacementReceipt["cpuExpertOverrides"];
  if (requirement.profile === "all_plus_cpu_moe") {
    const expected = requirement.expectedCpuMoe;
    if (!expected || cpuExpertTensors.length === 0) throw new Error("CPU-MoE placement requires explicit observed expert tensor override evidence");
    if (expected.requestKind === "all"
      && (expected.firstLayer !== 0
        || expected.lastLayer !== repeatingGpuLayers - 1
        || expected.layerCount !== repeatingGpuLayers)) {
      throw new Error("all-experts CPU-MoE placement contract must cover all repeating layers");
    }
    if (expected.requestKind === "first_n" && expected.firstLayer !== 0) {
      throw new Error("first-N CPU-MoE placement contract must begin at layer zero");
    }
    if (cpuExpertTensors.some((tensor) => !tensor.device.startsWith("CPU"))) throw new Error("CPU-MoE expert override is not assigned to CPU");
    const layers = [...new Set(cpuExpertTensors.map((tensor) => tensor.layer))].sort((left, right) => left - right);
    const ranges = contiguousRanges(layers);
    if (layers.length !== expected.layerCount
      || layers[0] !== expected.firstLayer
      || layers.at(-1) !== expected.lastLayer
      || cpuExpertTensors.length < expected.minimumMatchedTensors) {
      throw new Error("CPU-MoE expert override does not match the expected layer contract");
    }
    if (!modelBuffers.some((buffer) => buffer.device.startsWith("CPU"))
      || !modelBuffers.some((buffer) => !buffer.device.startsWith("CPU"))) {
      throw new Error("CPU-MoE placement requires CPU and GPU model buffers");
    }
    cpuExpertOverrides = {
      device: "CPU",
      requestKind: expected.requestKind,
      affectedLayerRanges: ranges,
      affectedLayerCount: layers.length,
      matchedTensorCount: cpuExpertTensors.length
    };
  }

  return {
    schemaVersion: "neondiff-llama-cpp-placement/v1",
    parser: { version: "llama.cpp-b9977-placement/v1", backendCommit: requirement.backendCommit },
    requestedGpuLayers: requirement.requestedGpuLayers,
    observedGpuLayers: total.observed,
    totalModelLayers: total.total,
    repeatingGpuLayers,
    outputLayerOffloaded,
    layerAssignments,
    modelBuffers,
    kv: { layerAssignments: kvLayerAssignments, buffers: kvBuffers, types: kvTypes[0] },
    outputBuffers,
    recurrentState: { layerAssignments: recurrentLayerAssignments, buffers: recurrentBuffers },
    computeBuffers,
    cpuExpertOverrides,
    contradictions,
    source: {
      schemaVersion: source.schemaVersion,
      capturedBytes: source.capturedBytes,
      capturedLines: source.capturedLines,
      truncated: source.truncated,
      sha256: source.sha256,
      eventCount: source.events.length
    }
  };
}
