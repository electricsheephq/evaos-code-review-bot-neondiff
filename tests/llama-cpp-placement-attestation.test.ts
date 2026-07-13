import { describe, expect, it } from "vitest";
import {
  captureLlamaCppStartup,
  createLlamaCppStartupCapture,
  LLAMA_CPP_STARTUP_MAX_BYTES,
  LLAMA_CPP_STARTUP_MAX_LINES,
  parseLlamaCppPlacementAttestation
} from "../src/llama-cpp-placement-attestation.js";

const BACKEND_COMMIT = "b9977";

function fullGpuLog(): string {
  return [
    "load_tensors: layer 0 assigned to device CUDA0, is_swa = 0",
    "load_tensors: layer 1 assigned to device CUDA0, is_swa = 0",
    "load_tensors: layer 2 assigned to device CUDA0, is_swa = 0",
    "load_tensors: offloading output layer to GPU",
    "load_tensors: offloading 2 repeating layers to GPU",
    "load_tensors: offloaded 3/3 layers to GPU",
    "load_tensors: CPU_Mapped model buffer size = 128.00 MiB",
    "load_tensors: CUDA0 model buffer size = 2048.00 MiB",
    "llama_kv_cache_unified: layer 0: dev = CUDA0",
    "llama_kv_cache_unified: layer 1: dev = CUDA0",
    "llama_kv_cache_unified: CUDA0 KV buffer size = 256.00 MiB",
    "llama_kv_cache_unified: size = 256.00 MiB (4096 cells, 3 layers, 1/1 seqs), K (f16): 128.00 MiB, V (f16): 128.00 MiB",
    "llama_context: CUDA0 output buffer size = 4.00 MiB",
    "sched_reserve: CUDA0 compute buffer size = 64.00 MiB"
  ].join("\n") + "\n";
}

function partialGpuLog(): string {
  return [
    "load_tensors: layer 0 assigned to device CUDA.0:1, is_swa = 0",
    "load_tensors: layer 1 assigned to device CUDA.0:1, is_swa = 0",
    "load_tensors: layer 2 assigned to device CPU, is_swa = 0",
    "load_tensors: offloading 2 repeating layers to GPU",
    "load_tensors: offloaded 2/3 layers to GPU",
    "load_tensors: CPU_Mapped model buffer size = 1024.00 MiB",
    "load_tensors: CUDA.0:1 model buffer size = 512.00 MiB",
    "llama_kv_cache: CPU KV buffer size = 64.00 MiB",
    "llama_kv_cache: CUDA.0:1 KV buffer size = 128.00 MiB",
    "llama_kv_cache: size = 192.00 MiB (4096 cells, 3 layers, 1/1 seqs), K (f16): 96.00 MiB, V (f16): 96.00 MiB",
    "sched_reserve: CUDA.0:1 compute buffer size = 32.00 MiB"
  ].join("\n") + "\n";
}

function cpuMoeExpertLines(): string {
  return [0, 1].flatMap((layer) => ["gate", "up", "down"].map((kind) =>
    `tensor blk.${layer}.ffn_${kind}_exps.weight (512 MiB q4_K) buffer type overridden to CPU`
  )).join("\n") + "\n";
}

function exactShapePrefixedTwoEpochPartialLog(): string {
  let clock = 0;
  const prefix = (line: string, severity: "D" | "I" = "D") =>
    `0.00.${String(clock++).padStart(3, "0")}.147 ${severity} ${line}`;
  const epoch = (probe: boolean): string[] => [
    ...Array.from({ length: 41 }, (_, layer) => prefix(
      `load_tensors: layer ${String(layer).padStart(3, " ")} assigned to device ${layer < 11 ? "CPU" : "CUDA0"}, is_swa = 0`
    )),
    prefix("load_tensors: offloading output layer to GPU", "I"),
    prefix("load_tensors: offloading 29 repeating layers to GPU", "I"),
    prefix("load_tensors: offloaded 30/41 layers to GPU", "I"),
    ...(probe ? [
      prefix("load_tensors:        CUDA0 model buffer size =     0.00 MiB", "I"),
      prefix("load_tensors:    CUDA_Host model buffer size =     0.00 MiB", "I")
    ] : [
      prefix("load_tensors:   CPU_Mapped model buffer size =  6141.52 MiB", "I"),
      prefix("load_tensors:        CUDA0 model buffer size = 15172.59 MiB", "I")
    ]),
    prefix(`llama_kv_cache:        CPU KV buffer size =     ${probe ? "0.00" : "2.00"} MiB`, "I"),
    prefix(`llama_kv_cache:      CUDA0 KV buffer size =     ${probe ? "0.00" : "8.00"} MiB`, "I"),
    prefix("llama_kv_cache: size = 10.00 MiB (4096 cells, 41 layers, 1/1 seqs), K (f16): 5.00 MiB, V (f16): 5.00 MiB", "I"),
    prefix("llama_context:  CUDA_Host  output buffer size =     0.95 MiB", "I"),
    prefix("sched_reserve:      CUDA0 compute buffer size =   262.00 MiB", "I")
  ];
  return [...epoch(true), ...epoch(false)].join("\n") + "\n";
}

describe("llama.cpp b9977 placement attestation", () => {
  it("parses a complete full-GPU startup receipt from bounded stream-tagged evidence", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(fullGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    });

    expect(receipt).toMatchObject({
      schemaVersion: "neondiff-llama-cpp-placement/v1",
      parser: { backendCommit: BACKEND_COMMIT, version: "llama.cpp-b9977-placement/v2" },
      requestedGpuLayers: 3,
      observedGpuLayers: 3,
      repeatingGpuLayers: 2,
      outputLayerOffloaded: true,
      layerAssignments: [
        { layer: 0, device: "CUDA0", isSwa: false },
        { layer: 1, device: "CUDA0", isSwa: false },
        { layer: 2, device: "CUDA0", isSwa: false }
      ],
      modelBuffers: [
        { device: "CPU_Mapped", mib: 128 },
        { device: "CUDA0", mib: 2048 }
      ],
      kv: {
        layerAssignments: [{ layer: 0, device: "CUDA0" }, { layer: 1, device: "CUDA0" }],
        buffers: [{ device: "CUDA0", mib: 256 }],
        types: { k: "f16", v: "f16" }
      },
      outputBuffers: [{ device: "CUDA0", mib: 4 }],
      computeBuffers: [{ device: "CUDA0", mib: 64 }],
      contradictions: []
    });
    expect(receipt.source.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.source.truncated).toBe(false);
  });

  it("selects the final complete b9977 load epoch while preserving the observed epoch count", () => {
    const probeEpoch = fullGpuLog()
      .replace("CPU_Mapped model buffer size = 128.00", "CPU_Mapped model buffer size = 0.00")
      .replace("CUDA0 model buffer size = 2048.00", "CUDA0 model buffer size = 0.00");
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${probeEpoch}${fullGpuLog()}`) }
    ], { maxBytes: 32_768, maxLines: 256 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    });

    expect(receipt.loadEpochsObserved).toBe(2);
    expect(receipt.modelBuffers).toEqual([
      { device: "CPU_Mapped", mib: 128 },
      { device: "CUDA0", mib: 2048 }
    ]);
  });

  it("normalizes the exact timestamp and severity prefix emitted by b9977 debug logging", () => {
    const prefixed = fullGpuLog().split("\n").filter(Boolean).map((line, index) =>
      `0.00.${String(index).padStart(3, "0")}.147 ${index % 2 === 0 ? "D" : "I"} ${line.replace("layer 0", "layer   0")}`
    ).join("\n") + "\n";
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(prefixed) }
    ], { maxBytes: 32_768, maxLines: 256 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    });

    expect(receipt.loadEpochsObserved).toBe(1);
    expect(source.events[0]?.line).toBe("load_tensors: layer   0 assigned to device CUDA0, is_swa = 0");
  });

  it("replays the redacted 41-layer prefixed two-epoch b9977 failure shape", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(exactShapePrefixedTwoEpochPartialLog()) }
    ], { maxBytes: 128 * 1024, maxLines: 512 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "partial_gpu",
      requestedGpuLayers: 30
    });

    expect(receipt).toMatchObject({
      loadEpochsObserved: 2,
      observedGpuLayers: 30,
      totalModelLayers: 41,
      repeatingGpuLayers: 29,
      modelBuffers: [
        { device: "CPU_Mapped", mib: 6141.52 },
        { device: "CUDA0", mib: 15172.59 }
      ]
    });
    expect(source.events).toHaveLength(102);
    expect(source.truncated).toBe(false);
  });

  it("rejects repeated b9977 load epochs whose placement assignments disagree", () => {
    const conflictingProbe = fullGpuLog().replace(
      "layer 1 assigned to device CUDA0",
      "layer 1 assigned to device CUDA1"
    );
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${conflictingProbe}${fullGpuLog()}`) }
    ], { maxBytes: 32_768, maxLines: 256 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    })).toThrow(/placement epochs disagree/i);
  });

  it("rejects a trailing incomplete b9977 load epoch", () => {
    const trailingEpoch = [
      "load_tensors: layer 0 assigned to device CUDA0, is_swa = 0",
      "load_tensors: CPU_Mapped model buffer size = 0.00 MiB"
    ].join("\n") + "\n";
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${fullGpuLog()}${trailingEpoch}`) }
    ], { maxBytes: 32_768, maxLines: 256 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    })).toThrow(/epoch 2 requires exactly one total GPU offload record/i);
  });

  it("parses a partial-GPU receipt with punctuation-bearing backend device names", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(partialGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "partial_gpu",
      requestedGpuLayers: 2
    });

    expect(receipt.observedGpuLayers).toBe(2);
    expect(receipt.layerAssignments).toContainEqual({ layer: 0, device: "CUDA.0:1", isSwa: false });
    expect(receipt.layerAssignments).toContainEqual({ layer: 2, device: "CPU", isSwa: false });
  });

  it("rejects CPU-MoE when only requested flags and expert tensor names exist", () => {
    const log = `${fullGpuLog()}create_tensor: loading tensor blk.0.ffn_gate_exps.weight\n`;
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(log) }
    ], { maxBytes: 16_384, maxLines: 128 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "all_plus_cpu_moe",
      requestedGpuLayers: 3,
      expectedCpuMoe: { requestKind: "all", firstLayer: 0, lastLayer: 1, layerCount: 2, minimumMatchedTensors: 6 }
    })).toThrow(/explicit observed expert tensor override/i);
  });

  it("decodes fragmented multibyte UTF-8 without replacement characters", () => {
    const prefix = Buffer.from("load_tensors: note café\n");
    const split = prefix.indexOf(0xc3) + 1;
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: prefix.subarray(0, split) },
      { stream: "stderr", chunk: prefix.subarray(split) }
    ], { maxBytes: 1024, maxLines: 8 });

    expect(source.events).toEqual([]);
    expect(source.capturedBytes).toBe(prefix.length);
  });

  it("rejects malformed UTF-8", () => {
    expect(() => captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from([0xc3, 0x28]) }
    ], { maxBytes: 1024, maxLines: 8 })).toThrow(/utf-8|encoded data/i);
  });

  it("rejects secret-looking text split across chunks", () => {
    expect(() => captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from("Authorization: Bea") },
      { stream: "stderr", chunk: Buffer.from("rer abcdefghijklmnopqrstuvwxyz123456\n") }
    ], { maxBytes: 1024, maxLines: 8 })).toThrow(/secret-like/i);
  });

  it("supports bounded incremental capture without retaining caller chunks", () => {
    const capture = createLlamaCppStartupCapture({ maxBytes: 16_384, maxLines: 128 });
    for (const line of fullGpuLog().split(/(?<=\n)/)) {
      capture.push({ stream: "stderr", chunk: Buffer.from(line) });
    }
    const source = capture.finalize();
    expect(source.capturedLines).toBe(14);
    expect(() => capture.push({ stream: "stderr", chunk: Buffer.from("late") })).toThrow(/finalized/i);
  });

  it("retains only placement-relevant startup lines while scanning all output", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`loading /Users/private/models/model.gguf\nload_tensors: private path /Users/private/models/model.gguf\n${fullGpuLog()}`) }
    ], { maxBytes: 16_384, maxLines: 128 });

    expect(source.events.some((event) => event.line.includes("/Users/private"))).toBe(false);
    expect(source.events.some((event) => event.line.startsWith("load_tensors:"))).toBe(true);
  });

  it("enforces hard byte, line, and per-line bounds", () => {
    expect(() => createLlamaCppStartupCapture({ maxBytes: LLAMA_CPP_STARTUP_MAX_BYTES + 1, maxLines: 128 })).toThrow(/maximum/i);
    expect(() => createLlamaCppStartupCapture({ maxBytes: 1024, maxLines: LLAMA_CPP_STARTUP_MAX_LINES + 1 })).toThrow(/maximum/i);
    expect(() => captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`load_tensors: ${"x".repeat(9000)}\n`) }
    ], { maxBytes: 16_384, maxLines: 128 })).toThrow(/line.*limit/i);
  });

  it("fails closed on any truncated offload-comparison capture", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${fullGpuLog()}trailing diagnostic that crosses the cap`) }
    ], { maxBytes: Buffer.byteLength(fullGpuLog()), maxLines: 128 });
    expect(source.truncated).toBe(true);

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    })).toThrow(/truncated/i);
  });

  it("rejects conflicting duplicate layer assignments", () => {
    const log = fullGpuLog().replace(
      "load_tensors: layer 0 assigned to device CUDA0, is_swa = 0\n",
      "load_tensors: layer 0 assigned to device CUDA0, is_swa = 0\nload_tensors: layer 0 assigned to device CPU, is_swa = 0\n"
    );
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(log) }
    ], { maxBytes: 16_384, maxLines: 128 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    })).toThrow(/duplicate|contradictory/i);
  });

  it("rejects identical duplicates and profile/summary contradictions", () => {
    const duplicatedLog = partialGpuLog().replace(
      "load_tensors: layer 0 assigned to device CUDA.0:1, is_swa = 0\n",
      "load_tensors: layer 0 assigned to device CUDA.0:1, is_swa = 0\nload_tensors: layer 0 assigned to device CUDA.0:1, is_swa = 0\n"
    );
    const duplicate = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(duplicatedLog) }
    ], { maxBytes: 16_384, maxLines: 128 });
    expect(() => parseLlamaCppPlacementAttestation(duplicate, {
      backendCommit: BACKEND_COMMIT,
      profile: "partial_gpu",
      requestedGpuLayers: 2
    })).toThrow(/duplicate.*layer/i);

    const mislabeledFull = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(partialGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });
    expect(() => parseLlamaCppPlacementAttestation(mislabeledFull, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 999
    })).toThrow(/full-gpu|fully offloaded/i);

    const mislabeledPartial = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(fullGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });
    expect(() => parseLlamaCppPlacementAttestation(mislabeledPartial, {
      backendCommit: BACKEND_COMMIT,
      profile: "partial_gpu",
      requestedGpuLayers: 3
    })).toThrow(/partial-gpu|partially offloaded/i);
  });

  it("accepts a literal -ngl 999 request when the backend proves every finite model layer offloaded", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(fullGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });
    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 999
    });
    expect(receipt.requestedGpuLayers).toBe(999);
    expect(receipt.observedGpuLayers).toBe(3);
    expect(receipt.totalModelLayers).toBe(3);
  });

  it("attests explicit b9977 CPU expert overrides and their exact layer contract", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${fullGpuLog()}${cpuMoeExpertLines()}`) }
    ], { maxBytes: 32_768, maxLines: 256 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "all_plus_cpu_moe",
      requestedGpuLayers: 999,
      expectedCpuMoe: { requestKind: "all", firstLayer: 0, lastLayer: 1, layerCount: 2, minimumMatchedTensors: 6 }
    });

    expect(receipt.cpuExpertOverrides).toMatchObject({
      device: "CPU",
      affectedLayerRanges: [{ firstLayer: 0, lastLayer: 1 }],
      affectedLayerCount: 2,
      matchedTensorCount: 6
    });
  });

  it("attests CPU-MoE overrides from the final one of two complete b9977 load epochs", () => {
    const probeEpoch = fullGpuLog()
      .replace("CPU_Mapped model buffer size = 128.00", "CPU_Mapped model buffer size = 0.00")
      .replace("CUDA0 model buffer size = 2048.00", "CUDA0 model buffer size = 0.00");
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${probeEpoch}${cpuMoeExpertLines()}${fullGpuLog()}${cpuMoeExpertLines()}`) }
    ], { maxBytes: 65_536, maxLines: 512 });

    const receipt = parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "all_plus_cpu_moe",
      requestedGpuLayers: 999,
      expectedCpuMoe: { requestKind: "all", firstLayer: 0, lastLayer: 1, layerCount: 2, minimumMatchedTensors: 6 }
    });

    expect(receipt.loadEpochsObserved).toBe(2);
    expect(receipt.cpuExpertOverrides).toMatchObject({
      affectedLayerCount: 2,
      matchedTensorCount: 6
    });
  });

  it("rejects an all-experts CPU-MoE contract that declares only part of the model's repeating layers", () => {
    const expertLines = ["gate", "up", "down"].map((kind) =>
      `tensor blk.0.ffn_${kind}_exps.weight (512 MiB q4_K) buffer type overridden to CPU`
    );
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${fullGpuLog()}${expertLines.join("\n")}\n`) }
    ], { maxBytes: 32_768, maxLines: 256 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "all_plus_cpu_moe",
      requestedGpuLayers: 999,
      expectedCpuMoe: { requestKind: "all", firstLayer: 0, lastLayer: 0, layerCount: 1, minimumMatchedTensors: 3 }
    })).toThrow(/all-experts.*repeating layers/i);
  });

  it("rejects a first-N CPU-MoE contract that does not begin at layer zero", () => {
    const expertLines = ["gate", "up", "down"].map((kind) =>
      `tensor blk.1.ffn_${kind}_exps.weight (512 MiB q4_K) buffer type overridden to CPU`
    );
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(`${fullGpuLog()}${expertLines.join("\n")}\n`) }
    ], { maxBytes: 32_768, maxLines: 256 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "all_plus_cpu_moe",
      requestedGpuLayers: 999,
      expectedCpuMoe: { requestKind: "first_n", firstLayer: 1, lastLayer: 1, layerCount: 1, minimumMatchedTensors: 3 }
    })).toThrow(/first-N.*layer zero/i);
  });

  it("rejects source event sequence and fingerprint drift", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(fullGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });
    source.events[0].sequence = 9;

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "full_gpu",
      requestedGpuLayers: 3
    })).toThrow(/fingerprint|sequence/i);
  });

  it("rejects unsupported backend variants", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(fullGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });

    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: "b10000",
      profile: "full_gpu",
      requestedGpuLayers: 3
    })).toThrow(/backend variant/i);
  });

  it("rejects unsupported placement profile values at runtime", () => {
    const source = captureLlamaCppStartup([
      { stream: "stderr", chunk: Buffer.from(fullGpuLog()) }
    ], { maxBytes: 16_384, maxLines: 128 });
    expect(() => parseLlamaCppPlacementAttestation(source, {
      backendCommit: BACKEND_COMMIT,
      profile: "typo" as never,
      requestedGpuLayers: 999
    })).toThrow(/placement profile/i);
  });
});
