import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildCodexExecInvocation, resolveCheckoutReadsStatus, runCodexReview, runCodexStructuredOutput } from "../src/codex-runtime.js";
const base = { cliPath: "codex", cwd: "/fixture/checkout", model: "gpt-6.1-sol", reasoningEffort: "high" as const,
  schemaPath: "/evidence/schema.json", outputPath: "/evidence/result.json" };
const readConfinement = { command: "/opt/codex/bin/codex", readableRoots: [base.cwd, "/opt/codex/bin"] };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
it("keeps trusted args byte-identical and restricts shell, docs and reads together", () => {
  const trusted = buildCodexExecInvocation(base);
  expect(trusted.args).toEqual(["exec", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config",
    "--disable", "apps", "--disable", "multi_agent", "--disable", "multi_agent_v2", "-c", 'approval_policy="never"',
    "-c", 'model_reasoning_effort="high"', "--model", base.model, "-c", 'shell_environment_policy.inherit="core"',
    "-c", 'shell_environment_policy.exclude=["*KEY*","*SECRET*","*TOKEN*","*PASSWORD*","*CREDENTIAL*","*AUTH*"]',
    "--sandbox", "read-only", "--cd", base.cwd, "--output-schema", base.schemaPath, "--output-last-message", base.outputPath, "--color", "never", "-"]);
  expect(buildCodexExecInvocation({ ...base, restrictTools: false })).toEqual(trusted);
  const restricted = buildCodexExecInvocation({ ...base, restrictTools: true, readConfinement });
  expect(restricted.args.join(" ")).toContain("--disable shell_tool");
  expect(restricted.args).toContain("project_doc_max_bytes=0");
  expect(restricted.args).not.toContain("--sandbox");
  expect(restricted.args).toContain('permissions.neondiff_checkout_read.filesystem={":minimal"="read", "/fixture/checkout"="read", "/opt/codex/bin"="read"}');
  expect(() => buildCodexExecInvocation({ ...base, restrictTools: true })).toThrow("confinement");
});
it("requires confinement even with checkout reads disabled and rejects old Codex", () => {
  const resolver = vi.fn(() => readConfinement);
  for (const version of ["0.162.0", "0.163.0"]) {
    const result = resolveCheckoutReadsStatus({ checkoutReads: false, restrictTools: true, cwd: base.cwd, cliPath: base.cliPath },
      { readVersion: () => `codex-cli ${version}`, resolveReadConfinement: resolver });
    expect(result.status).toBe(version === "0.163.0" ? "enabled" : "unavailable:codex_version");
  }
  expect(resolver).toHaveBeenCalledWith(base.cwd, base.cliPath, expect.any(Object), true);
});
it("threads restrictions through review and structured output; disables citation schema and verification", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "restricted-unit-")); roots.push(cwd);
  const runProcess = vi.fn(async (invocation) => {
    expect(invocation.args.join(" ")).toContain("--disable shell_tool");
    writeFileSync(invocation.outputPath, JSON.stringify({ findings: [], summary: { changedBehavior: [], invariants: [], evidence: [], limitations: ["Fixture"], noFindingRationale: "Fixture" } }));
    return { stdout: "", stderr: "", status: 0, signal: null };
  });
  const input = { ...base, cwd, prompt: "Fixture", evidenceDir: join(cwd, "evidence"), timeoutMs: 1000, maxOutputBytes: 10000, restrictTools: true, readConfinement };
  const deps = { runProcess, captureWorktreeState: () => "unchanged" };
  const result = await runCodexReview({ ...input, checkoutReads: true }, deps);
  expect(result.droppedFromEvidence).toBeUndefined();
  const schema = JSON.parse(readFileSync(join(input.evidenceDir, "codex-review-schema.json"), "utf8"));
  expect(schema.properties.findings.items.properties).not.toHaveProperty("evidence");
  await runCodexStructuredOutput({ ...input, artifactPrefix: "fixture", schema: {}, parse: value => value }, deps);
  expect(runProcess).toHaveBeenCalledTimes(2);
});
