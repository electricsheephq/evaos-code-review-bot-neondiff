import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalArgvFingerprint,
  appendBoundedLinuxTrace,
  createGex44ResourceMonitor,
  linuxRuntimeModulePath,
  verifyLinuxListenerOwnership,
  verifyLinuxProcessIdentity
} from "../src/linux-phase1-runtime.js";

describe("GEX44 Linux Phase 1 runtime", () => {
  it("uses the runner's canonical sorted-object argv identity", () => {
    const argv = ["/bin/tool", "--port", "8080"];
    expect(canonicalArgvFingerprint(argv)).toBe(createHash("sha256").update(JSON.stringify(argv)).digest("hex"));
    expect(canonicalArgvFingerprint(["/bin/tool", "--port", "8080"])).not.toBe(canonicalArgvFingerprint(["/bin/tool", "8080", "--port"]));
  });

  it("preserves the run-start swap baseline while bounding a long trace", () => {
    const sample = (index: number) => ({ capturedAt: String(index), phase: index === 0 ? "attached" : "periodic", rssBytes: 0, vramBytes: 0, swapBytes: index * 1024, processSwapBytes: 0, processAlive: 1, pid: 42 });
    const trace: ReturnType<typeof sample>[] = [];
    for (let index = 0; index < 10; index += 1) appendBoundedLinuxTrace(trace, sample(index), 4);
    expect(trace.map((entry) => entry.capturedAt)).toEqual(["0", "7", "8", "9"]);
    expect(trace[0].swapBytes).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("proves the current process executable and argv from procfs", async () => {
    const realExecutable = (await import("node:fs")).readlinkSync(`/proc/${process.pid}/exe`);
    const executableSha = createHash("sha256").update(readFileSync(realExecutable)).digest("hex");
    const argv = readFileSync(`/proc/${process.pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
    expect(await verifyLinuxProcessIdentity(process.pid, executableSha, canonicalArgvFingerprint(argv))).toBe(true);
    expect(await verifyLinuxProcessIdentity(process.pid, "0".repeat(64), canonicalArgvFingerprint(argv))).toBe(false);
  });

  it.skipIf(process.platform !== "linux")("hashes the running procfs image rather than a replaced executable pathname", async () => {
    const directory = mkdtempSync(join(tmpdir(), "phase1-proc-image-"));
    const executable = join(directory, "node-copy");
    copyFileSync(process.execPath, executable);
    chmodSync(executable, 0o700);
    const expectedSha = createHash("sha256").update(readFileSync(executable)).digest("hex");
    const child = spawn(executable, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (!child.pid) throw new Error("test process has no PID");
      const argv = readFileSync(`/proc/${child.pid}/cmdline`).toString("utf8").split("\0").filter(Boolean);
      unlinkSync(executable);
      writeFileSync(executable, "replacement bytes", { mode: 0o700 });
      expect(await verifyLinuxProcessIdentity(child.pid, expectedSha, canonicalArgvFingerprint(argv))).toBe(true);
    } finally {
      child.kill("SIGKILL");
      if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== "linux")("proves exact PID ownership of a loopback listener", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test listener has no TCP address");
      expect(await verifyLinuxListenerOwnership(process.pid, "127.0.0.1", address.port)).toBe(true);
      expect(await verifyLinuxListenerOwnership(process.pid, "127.0.0.1", address.port + 1)).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("fails closed until a monitor session is attached to a resident PID", async () => {
    const monitor = createGex44ResourceMonitor({ nvidiaSmiSha256: "0".repeat(64) });
    const session = await monitor.start();
    await expect(monitor.sample(session, { phase: "before" })).rejects.toThrow(/not attached/i);
  });

  it("isolates sessions between independently created monitor instances", async () => {
    const first = createGex44ResourceMonitor({ nvidiaSmiSha256: "0".repeat(64) });
    const second = createGex44ResourceMonitor({ nvidiaSmiSha256: "0".repeat(64) });
    const session = await first.start();
    await expect(second.sample(session, { phase: "before" })).rejects.toThrow(/session is unknown/i);
  });

  it("deletes a monitor session even when terminal capture fails", async () => {
    const monitor = createGex44ResourceMonitor({ nvidiaSmiSha256: "0".repeat(64) });
    const session = await monitor.start();
    await expect(monitor.stop(session)).rejects.toThrow(/not attached/i);
    await expect(monitor.stop(session)).rejects.toThrow(/session is unknown/i);
  });

  it("rejects missing or malformed immutable nvidia-smi factory parameters", () => {
    expect(() => createGex44ResourceMonitor({} as { nvidiaSmiSha256: string })).toThrow(/nvidia-smi SHA-256/i);
    expect(() => createGex44ResourceMonitor({ nvidiaSmiSha256: "not-a-digest" })).toThrow(/nvidia-smi SHA-256/i);
  });

  it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/nvidia-smi"))("executes the opened pinned nvidia-smi image through procfs", async () => {
    const expectedSha256 = createHash("sha256").update(readFileSync("/usr/bin/nvidia-smi")).digest("hex");
    const monitor = createGex44ResourceMonitor({ nvidiaSmiSha256: expectedSha256 });
    const session = await monitor.start();
    await monitor.attach(session, { metadata: { pid: process.pid } });
    await expect(monitor.sample(session, { phase: "before" })).resolves.toMatchObject({ pid: process.pid, processAlive: 1 });
    await expect(monitor.stop(session)).resolves.toEqual(expect.any(Array));
  });

  it("exposes the exact module path used for immutable runtime binding", () => {
    expect(linuxRuntimeModulePath()).toMatch(/linux-phase1-runtime\.(?:ts|js)$/);
  });
});
