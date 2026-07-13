import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { closeSync, fstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type LinuxResourceSample = {
  capturedAt: string;
  sequence: number;
  phase: string;
  rssBytes: number;
  vramBytes: number;
  vramObserved: number;
  swapBytes: number;
  processSwapBytes: number;
  processAlive: number;
  pid: number;
  periodicFailure?: number;
  cleanupFailure?: number;
  nvidiaSmiDrift?: number;
};

type Session = {
  id: string;
  pid?: number;
  processStartToken?: string;
  nvidiaSmiFd?: number;
  sequence: number;
  samples: LinuxResourceSample[];
  captureQueue: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: boolean;
  periodicFailure?: string;
};

const NVIDIA_SMI = "/usr/bin/nvidia-smi";
const MAX_SAMPLES = 4096;
const SAMPLE_INTERVAL_MS = 1000;
const SWAP_GROWTH_LIMIT_BYTES = 64 * 1024 * 1024;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalArgvFingerprint(argv: string[]): string {
  return createHash("sha256").update(canonical(argv)).digest("hex");
}

export function appendBoundedLinuxTrace(samples: LinuxResourceSample[], sample: LinuxResourceSample, maximum = MAX_SAMPLES): void {
  if (!Number.isSafeInteger(maximum) || maximum < 2) throw new Error("resource trace cap must preserve a baseline and terminal tail");
  samples.push(sample);
  if (samples.length > maximum) samples.splice(1, samples.length - maximum);
}

export function linuxRuntimeModulePath(): string {
  return fileURLToPath(import.meta.url);
}

export function assertGex44LinuxPreflight(expectedNvidiaSmiSha256: string): void {
  if (process.platform !== "linux") throw new Error("GEX44 characterization requires Linux");
  if (!/^[a-f0-9]{64}$/.test(expectedNvidiaSmiSha256)) throw new Error("nvidia-smi SHA-256 is invalid");
  const metadata = statSync(NVIDIA_SMI);
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error("pinned nvidia-smi path is not executable");
  if (sha256File(NVIDIA_SMI) !== expectedNvidiaSmiSha256) throw new Error("nvidia-smi SHA-256 does not match the immutable plan");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Descriptor(fd: number): string {
  const size = fstatSync(fd).size;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < size;) {
    const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (bytesRead === 0) throw new Error("pinned executable changed while hashing");
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  return hash.digest("hex");
}

function positivePid(value: unknown): number {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("resident metadata does not contain a safe PID");
  return pid;
}

export async function verifyLinuxProcessIdentity(pid: number, executableSha256: string, argvFingerprint: string): Promise<boolean> {
  try {
    const executableHandle = `/proc/${positivePid(pid)}/exe`;
    const argv = readFileSync(`/proc/${pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    return sha256File(executableHandle) === executableSha256 && canonicalArgvFingerprint(argv) === argvFingerprint;
  } catch {
    return false;
  }
}

function listenerInodes(host: string, port: number): Set<string> {
  if (host !== "127.0.0.1" || !Number.isSafeInteger(port) || port < 1 || port > 65535) return new Set();
  const expectedAddress = "0100007F";
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  const found = new Set<string>();
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let lines: string[];
    try { lines = readFileSync(path, "utf8").trim().split("\n").slice(1); } catch { continue; }
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      const [address, encodedPort] = (fields[1] ?? "").split(":");
      const ipv4MappedLoopback = address === "0000000000000000FFFF00000100007F";
      if ((address === expectedAddress || ipv4MappedLoopback) && encodedPort === expectedPort && fields[3] === "0A" && /^\d+$/.test(fields[9] ?? "")) found.add(fields[9]);
    }
  }
  return found;
}

export async function verifyLinuxListenerOwnership(pid: number, host: string, port: number): Promise<boolean> {
  const inodes = listenerInodes(host, port);
  if (inodes.size === 0) return false;
  try {
    for (const descriptor of readdirSync(`/proc/${positivePid(pid)}/fd`)) {
      let target: string;
      try { target = readlinkSync(`/proc/${pid}/fd/${descriptor}`); } catch { continue; }
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match && inodes.has(match[1])) return true;
    }
  } catch { return false; }
  return false;
}

function statusBytes(pid: number, field: "VmRSS" | "VmSwap"): number {
  try {
    const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((candidate) => candidate.startsWith(`${field}:`));
    const match = line?.match(/^\w+:\s+(\d+)\s+kB$/);
    return match ? Number(match[1]) * 1024 : 0;
  } catch { return 0; }
}

function hostSwapUsedBytes(): number {
  const values = new Map<string, number>();
  for (const line of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const match = line.match(/^(SwapTotal|SwapFree):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get("SwapTotal");
  const free = values.get("SwapFree");
  if (total === undefined || free === undefined || free > total) throw new Error("host swap counters are unavailable");
  return total - free;
}

function processStartToken(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    const fieldsAfterCommand = stat.slice(close + 2).trim().split(/\s+/);
    return fieldsAfterCommand[19]; // proc(5) field 22, after pid and parenthesized comm
  } catch { return undefined; }
}

function processAlive(pid: number, expectedStartToken?: string): boolean {
  try {
    if (!statSync(`/proc/${pid}`).isDirectory()) return false;
    return expectedStartToken === undefined || processStartToken(pid) === expectedStartToken;
  } catch { return false; }
}

function openPinnedNvidiaSmi(expectedNvidiaSmiSha256: string): number {
  const fd = openSync(NVIDIA_SMI, "r");
  try {
    const metadata = fstatSync(fd);
    if (!metadata.isFile() || (metadata.mode & 0o111) === 0) throw new Error("pinned nvidia-smi image is not executable");
    if (sha256Descriptor(fd) !== expectedNvidiaSmiSha256) throw new Error("nvidia-smi SHA-256 drifted before execution");
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

async function queryVramBytes(pid: number, nvidiaSmiFd: number): Promise<{ bytes: number; observed: number }> {
  // The descriptor is pinned and hashed at attach, then re-hashed before the
  // run can terminate successfully. This prevents pathname replacement and
  // fails terminal evidence on ordinary in-session inode mutation without
  // adding full-binary hashing overhead to every one-second sample. A
  // privileged mutate-and-restore attack is outside this evidence boundary.
  const output = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(`/proc/${process.pid}/fd/${nvidiaSmiFd}`, ["--query-compute-apps=pid,used_memory", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }
    }, (error, stdout) => {
      if (error) rejectPromise(error);
      else resolvePromise(stdout);
    });
  });
  let mib = 0;
  let observed = 0;
  for (const line of output.trim().split("\n")) {
    const match = line.match(/^\s*(\d+)\s*,\s*(\d+(?:\.\d+)?)\s*$/);
    if (match && Number(match[1]) === pid) {
      observed = 1;
      mib += Number(match[2]);
    }
  }
  return { bytes: Math.round(mib * 1024 * 1024), observed };
}

async function capture(session: Session, phase: string): Promise<LinuxResourceSample> {
  if (!session.pid) throw new Error("resource monitor is not attached to a resident PID");
  const alive = processAlive(session.pid, session.processStartToken);
  if (alive && session.nvidiaSmiFd === undefined) throw new Error("resource monitor has no pinned nvidia-smi descriptor");
  const vram = alive ? await queryVramBytes(session.pid, session.nvidiaSmiFd as number) : { bytes: 0, observed: 0 };
  const sample: LinuxResourceSample = {
    capturedAt: new Date().toISOString(),
    sequence: ++session.sequence,
    phase,
    rssBytes: alive ? statusBytes(session.pid, "VmRSS") : 0,
    vramBytes: vram.bytes,
    vramObserved: vram.observed,
    swapBytes: hostSwapUsedBytes(),
    processSwapBytes: alive ? statusBytes(session.pid, "VmSwap") : 0,
    processAlive: alive ? 1 : 0,
    pid: session.pid,
    periodicFailure: session.periodicFailure ? 1 : 0
  };
  appendBoundedLinuxTrace(session.samples, sample);
  return sample;
}

function enqueueCapture(session: Session, phase: string, rejectOnPeriodicFailure = false): Promise<LinuxResourceSample> {
  const operation = session.captureQueue.then(async () => {
    if (rejectOnPeriodicFailure && session.periodicFailure) throw new Error(`periodic resource sampling failed: ${session.periodicFailure}`);
    return capture(session, phase);
  });
  session.captureQueue = operation.then(
    () => undefined,
    (error) => {
      if (phase === "periodic") session.periodicFailure = error instanceof Error ? error.name : "periodic_sample_failed";
    }
  );
  return operation;
}

/** Pinned, self-contained module factory loaded from exact verified bytes. */
export function createGex44ResourceMonitor(parameters: { nvidiaSmiSha256: string }) {
  const expectedNvidiaSmiSha256 = parameters?.nvidiaSmiSha256;
  if (!/^[a-f0-9]{64}$/.test(expectedNvidiaSmiSha256 ?? "")) throw new Error("nvidia-smi SHA-256 factory parameter is invalid");
  const sessions = new Map<string, Session>();
  return {
    async start() {
      const id = randomUUID();
      sessions.set(id, { id, samples: [], sequence: 0, captureQueue: Promise.resolve() });
      return { id };
    },
    async attach(sessionRef: { id: string }, resident: { metadata?: Record<string, unknown> }) {
      const session = sessions.get(sessionRef.id);
      if (!session) throw new Error("resource monitor session is unknown");
      if (session.nvidiaSmiFd !== undefined) throw new Error("resource monitor session is already attached");
      const pid = positivePid(resident.metadata?.pid);
      const startToken = processStartToken(pid);
      if (!startToken) throw new Error("resident process start identity is unavailable");
      const nvidiaSmiFd = openPinnedNvidiaSmi(expectedNvidiaSmiSha256);
      const attached: Session = { ...session, samples: [...session.samples], pid, processStartToken: startToken, nvidiaSmiFd };
      try {
        await enqueueCapture(attached, "attached");
      } catch (error) {
        closeSync(nvidiaSmiFd);
        throw error;
      }
      session.pid = pid;
      session.processStartToken = startToken;
      session.nvidiaSmiFd = nvidiaSmiFd;
      session.samples = attached.samples;
      session.sequence = attached.sequence;
      session.captureQueue = attached.captureQueue;
      const schedulePeriodic = () => {
        if (session.stopping || session.periodicFailure) return;
        session.timer = setTimeout(() => {
          void enqueueCapture(session, "periodic").then(schedulePeriodic, schedulePeriodic);
        }, SAMPLE_INTERVAL_MS);
        session.timer.unref();
      };
      schedulePeriodic();
    },
    async sample(sessionRef: { id: string }, context: { phase: string }) {
      const session = sessions.get(sessionRef.id);
      if (!session) throw new Error("resource monitor session is unknown");
      return enqueueCapture(session, context.phase, true);
    },
    classify(samples: LinuxResourceSample[]) {
      if (samples.length === 0) return { status: "stopped" as const, errorCode: "resource_trace_empty" };
      const integrityFailures = [
        samples.some((sample) => sample.periodicFailure === 1) ? "periodic_resource_sampling_failed" : undefined,
        samples.some((sample) => sample.cleanupFailure === 1) ? "resource_cleanup_sampling_failed" : undefined,
        samples.some((sample) => sample.nvidiaSmiDrift === 1) ? "nvidia_smi_descriptor_drift" : undefined
      ].filter((value): value is string => value !== undefined);
      if (integrityFailures.length > 0) return { status: "stopped" as const, errorCode: integrityFailures.join("+") };
      const baseline = samples[0].processSwapBytes;
      const sustained = samples.slice(-3);
      if (sustained.length === 3 && sustained.every((sample) => sample.processSwapBytes - baseline > SWAP_GROWTH_LIMIT_BYTES)) {
        return { status: "stopped" as const, errorCode: "sustained_swap_growth" };
      }
      const terminal = samples[samples.length - 1];
      if (terminal.phase === "cleanup" && terminal.processAlive !== 0) return { status: "stopped" as const, errorCode: "resident_cleanup_not_proven" };
      return undefined;
    },
    async stop(sessionRef: { id: string }) {
      const session = sessions.get(sessionRef.id);
      if (!session) throw new Error("resource monitor session is unknown");
      try {
        session.stopping = true;
        if (session.timer) clearTimeout(session.timer);
        let final: LinuxResourceSample;
        try {
          final = await enqueueCapture(session, "cleanup");
        } catch (error) {
          if (!session.pid || !session.processStartToken || session.nvidiaSmiFd === undefined) throw error;
          const previous = session.samples.at(-1);
          const alive = processAlive(session.pid, session.processStartToken);
          final = {
            capturedAt: new Date().toISOString(),
            sequence: ++session.sequence,
            phase: "cleanup",
            rssBytes: alive ? statusBytes(session.pid, "VmRSS") : 0,
            vramBytes: previous?.vramBytes ?? 0,
            vramObserved: 0,
            swapBytes: previous?.swapBytes ?? 0,
            processSwapBytes: alive ? statusBytes(session.pid, "VmSwap") : 0,
            processAlive: alive ? 1 : 0,
            pid: session.pid,
            periodicFailure: session.periodicFailure ? 1 : 0,
            cleanupFailure: 1
          };
          appendBoundedLinuxTrace(session.samples, final);
        }
        try {
          if (session.nvidiaSmiFd !== undefined && sha256Descriptor(session.nvidiaSmiFd) !== expectedNvidiaSmiSha256) final.nvidiaSmiDrift = 1;
        } catch {
          final.nvidiaSmiDrift = 1;
        }
        return [...session.samples.slice(0, -1), final];
      } finally {
        if (session.nvidiaSmiFd !== undefined) {
          closeSync(session.nvidiaSmiFd);
        }
        sessions.delete(sessionRef.id);
      }
    }
  };
}
