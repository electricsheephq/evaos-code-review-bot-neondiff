import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { loadConfigFromObject } from "../src/config.js";
const read = (path: string) => readFileSync(path, "utf8");

it("item 1: records the local non-posting activation exemption on both policy surfaces", () => {
  for (const path of ["AGENTS.md", "docs/license-boundary.md"]) {
    expect(read(path)).toMatch(/`review-local`[^.]*local[^.]*posts nothing[^.]*no activation/i);
  }
});
it("item 2: documents an actionable CI workflow without checking out PR code", () => {
  const yaml = read("docs/ci-runner.md").match(/```yaml\n([\s\S]*?)```/)![1]!;
  const workflow = parse(yaml);
  expect(workflow.on.pull_request_target.types).toEqual(["opened", "ready_for_review"]);
  expect(workflow.on.issue_comment.types).toEqual(["created"]);
  expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "write" });
  const job = workflow.jobs.neondiff;
  expect(job.if).toContain("startsWith(github.event.comment.body, '/neondiff review')");
  expect(job.if).toContain("github.event.issue.pull_request");
  expect(job.if).toContain('"OWNER","MEMBER","COLLABORATOR"');
  // Per-PR serialization lives on the job, so non-command comments never join (or displace) the group.
  expect(workflow.concurrency).toBeUndefined();
  expect(job.concurrency).toEqual({ group: "neondiff-review-${{ github.event.pull_request.number || github.event.issue.number }}",
    "cancel-in-progress": false });
  expect(yaml).not.toMatch(/actions\/checkout|neondiff-action/);
  for (const step of job.steps.filter((s: { uses?: string }) => s.uses)) expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
  expect(job.steps.find((s: { with?: object }) => s.with)?.with["node-version"]).toBe(26);
  expect(yaml).toContain("npm install -g @openai/codex@0.163.0");
  expect(yaml).toContain("npx --yes neondiff@1.1.1 review-pr --ci");
  expect(yaml).toContain("install -m 600 /dev/null");
  expect(yaml).toContain("NEONDIFF_LICENSE_KEY_FILE");
  expect(yaml).toContain("secrets.OPENAI_API_KEY");
  expect(yaml).toContain("secrets.GITHUB_TOKEN");
  expect(yaml).toContain('if [ -n "$MODEL" ]');
  expect(yaml).toContain('if [ -n "$EFFORT" ]');
});
it("item 3: links private CI license setup from all three repository setup surfaces", () => {
  for (const path of ["README.md", "docs/SETUP.md", "docs/github-app-setup.md"]) {
    expect(read(path)).toContain("ci-runner.md#private-repositories");
  }
});
it("vision carves review-local out of the entitlement invariant", () => {
  expect(read("docs/vision.md")).toMatch(/`review-local`[^.]*posts nothing, is the documented exemption/);
});
it("item 4: scopes contributor and design activation policy to non-public work", () => {
  for (const path of ["AGENTS.md", "CONTRIBUTING.md", "docs/vision.md"]) {
    expect(read(path)).toMatch(/private, internal, and unknown-visibility[\s\S]{0,100}commercial non-public/i);
    expect(read(path)).not.toMatch(/private, internal, and\s+commercial\s+repository|Private or commercial review/);
  }
});
it("item 9: ships the local guide and rejects a packlist missing it", () => {
  const pkg = JSON.parse(read("package.json"));
  expect(pkg.files).toContain("docs/review-local.md");
  const required = [...read("scripts/check-packlist.mjs").split("for (const required of [")[1]!.matchAll(/"([^"]+)"/g)]
    .map(m => m[1]).filter(p => p !== "docs/review-local.md");
  const root = mkdtempSync(join(tmpdir(), "nd-packlist-"));
  try {
    const file = join(root, "pack.json");
    writeFileSync(file, JSON.stringify([{ files: required.map(path => ({ path })) }]));
    const missing = spawnSync(process.execPath, ["scripts/check-packlist.mjs", file], { encoding: "utf8" });
    expect(missing.status).toBe(1); expect(missing.stderr).toContain("docs/review-local.md");
    writeFileSync(file, JSON.stringify([{ files: [...required, "docs/review-local.md"].map(path => ({ path })) }]));
    expect(spawnSync(process.execPath, ["scripts/check-packlist.mjs", file]).status).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("item 12: lifecycle upgrade assertion accepts the real legacy fixture's effective policy", () => {
  const workflow = parse(read(".github/workflows/license-lifecycle-proof.yml"));
  const steps = Object.values(workflow.jobs).flatMap((j: any) => j.steps);
  const shell = steps.find((s: any) => s.run?.includes('const expected = ["enabled"')) as { run: string };
  const code = shell.run.match(/node -e '\n([\s\S]*?const expected = [\s\S]*?)\n\s*' "\$RUNNER_TEMP\/upgrade-config-inspect.json"/)![1]!;
  const config = loadConfigFromObject(JSON.parse(read("tests/fixtures/config/v1.0.3-legacy-license.json")));
  const root = mkdtempSync(join(tmpdir(), "nd-lifecycle-"));
  try {
    const file = join(root, "report.json"); writeFileSync(file, JSON.stringify({ ok: true, config }));
    expect(spawnSync(process.execPath, ["-e", code, file]).status).toBe(0);
    expect(shell.run).toContain("publicReposFree: true");
    expect(code).toContain('diagnostics.has("publicReposFree")');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
