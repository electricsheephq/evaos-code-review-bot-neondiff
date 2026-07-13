import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

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

  it("requires the built pinned JavaScript runtime rather than executing mutable TypeScript source", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "phase1-characterization-cli-source-")));
    const path = join(directory, "plan.json");
    const bytes = JSON.stringify({ schemaVersion: "neondiff-phase1-characterization-plan/v1", spec: {}, baseUrl: "http://127.0.0.1:8080", monitorModule: {} });
    writeFileSync(path, bytes);
    const result = run(["--plan", path, "--sha256", createHash("sha256").update(bytes).digest("hex")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/pinned built JavaScript artifact/);
  });
});
