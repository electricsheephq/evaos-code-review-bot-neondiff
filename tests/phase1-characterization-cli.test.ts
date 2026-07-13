import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { assertCharacterizationLoadedArtifacts, assertMonitorNvidiaBinding, assertPinnedLoadedJavaScript } from "../src/phase1-characterization-cli.js";

const cli = join(process.cwd(), "src", "phase1-characterization-cli.ts");
const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");

function run(args: string[]): { status: number | null; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync(tsx, [cli, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
    return { status: 0, stderr: "", stdout };
  } catch (error) {
    const result = error as { status?: number; stderr?: string; stdout?: string };
    return { status: result.status ?? null, stderr: String(result.stderr ?? ""), stdout: String(result.stdout ?? "") };
  }
}

describe("private Phase 1 characterization entrypoint", () => {
  it("binds the monitor factory to the plan's exact nvidia-smi digest", () => {
    const digest = "a".repeat(64);
    const identity = { version: "monitor/v1", modulePath: "/tmp/monitor.js", moduleSha256: "b".repeat(64), approvedRoot: "/tmp", exportName: "createMonitor", factoryParameters: { nvidiaSmiSha256: digest } };
    expect(() => assertMonitorNvidiaBinding(digest, identity)).not.toThrow();
    expect(() => assertMonitorNvidiaBinding("c".repeat(64), identity)).toThrow(/not bound/i);
    expect(() => assertMonitorNvidiaBinding(digest, { ...identity, factoryParameters: undefined })).toThrow(/not bound/i);
  });

  it("binds each actually loaded JavaScript artifact to its declared canonical path and bytes", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-loaded-js-")));
    const entrypoint = join(directory, "entrypoint.js");
    const runner = join(directory, "runner.js");
    writeFileSync(entrypoint, "export const entrypoint = true;\n");
    writeFileSync(runner, "export const runner = true;\n");
    const entrypointSha256 = createHash("sha256").update("export const entrypoint = true;\n").digest("hex");

    expect(() => assertPinnedLoadedJavaScript(entrypoint, entrypoint, entrypointSha256, "characterization entrypoint")).not.toThrow();
    expect(() => assertPinnedLoadedJavaScript(entrypoint, runner, entrypointSha256, "characterization entrypoint")).toThrow(/loaded path/i);
    expect(() => assertPinnedLoadedJavaScript(entrypoint, entrypoint, "0".repeat(64), "characterization entrypoint")).toThrow(/SHA-256/i);
    const TypeScriptPath = entrypoint.replace(/\.js$/, ".ts");
    expect(() => assertPinnedLoadedJavaScript(entrypoint, TypeScriptPath, entrypointSha256, "characterization entrypoint")).toThrow(/built JavaScript/i);
    expect(() => assertPinnedLoadedJavaScript(TypeScriptPath, entrypoint, entrypointSha256, "characterization entrypoint")).toThrow(/built JavaScript/i);
  });

  it("requires both the loaded entrypoint and imported runner bytes named by the plan", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-artifact-set-")));
    const entrypoint = join(directory, "entrypoint.js");
    const runner = join(directory, "runner.js");
    writeFileSync(entrypoint, "export const entrypoint = true;\n");
    writeFileSync(runner, "export const runner = true;\n");
    const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    const plan = {
      spec: {
        harness: {
          entrypointPath: entrypoint,
          entrypointSha256: digest(entrypoint),
          runnerPath: runner,
          runnerSha256: digest(runner)
        }
      }
    };

    expect(() => assertCharacterizationLoadedArtifacts(plan, { entrypointPath: entrypoint, runnerPath: runner })).not.toThrow();
    writeFileSync(runner, "export const runner = false;\n");
    expect(() => assertCharacterizationLoadedArtifacts(plan, { entrypointPath: entrypoint, runnerPath: runner })).toThrow(/screening runner SHA-256/i);
  });

  it("requires one explicit absolute plan and exposes no broad command surface", () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/usage: phase1-characterization-cli --plan/);
  });

  it("rejects an unsupported plan before starting a resident", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-cli-")));
    const path = join(directory, "plan.json");
    const bytes = JSON.stringify({ schemaVersion: "wrong" });
    writeFileSync(path, bytes);
    const result = run(["--plan", path, "--sha256", createHash("sha256").update(bytes).digest("hex")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/schema is unsupported/);
    expect(result.stdout).toBe("");
  });

  it("rejects plan-byte drift before parsing or process startup", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-cli-drift-")));
    const path = join(directory, "plan.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: "neondiff-phase1-characterization-plan/v1" }));
    const result = run(["--plan", path, "--sha256", "0".repeat(64)]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/SHA-256 does not match/);
  });

  it("rejects a plan that omits the loaded entrypoint or runner identities", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-missing-loaded-js-")));
    const path = join(directory, "plan.json");
    const bytes = JSON.stringify({
      schemaVersion: "neondiff-phase1-characterization-plan/v1",
      spec: { harness: {} },
      baseUrl: "http://127.0.0.1:8080",
      runtimeSha256: "0".repeat(64),
      nvidiaSmiSha256: "0".repeat(64),
      monitorModule: {}
    });
    writeFileSync(path, bytes);
    const result = run(["--plan", path, "--sha256", createHash("sha256").update(bytes).digest("hex")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/loaded JavaScript identities/i);
  });

  it("requires the built pinned JavaScript runtime rather than executing mutable TypeScript source", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-cli-source-")));
    const path = join(directory, "plan.json");
    const runnerSource = join(process.cwd(), "src", "phase1-screening-runner.ts");
    const bytes = JSON.stringify({
      schemaVersion: "neondiff-phase1-characterization-plan/v1",
      spec: {
        harness: {
          entrypointPath: cli,
          entrypointSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
          runnerPath: runnerSource,
          runnerSha256: createHash("sha256").update(readFileSync(runnerSource)).digest("hex")
        }
      },
      baseUrl: "http://127.0.0.1:8080",
      monitorModule: {}
    });
    writeFileSync(path, bytes);
    const result = run(["--plan", path, "--sha256", createHash("sha256").update(bytes).digest("hex")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pinned built JavaScript artifact/);
  });
});
