import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runReviewLocal, reviewBenchMessage, parseLocalDiff } from "../src/review-local.js";
import { resolveCheckoutReadsStatus, runCodexReview } from "../src/codex-runtime.js";
import { GitHubApi } from "../src/github.js";
import { requireActiveProductionLicense } from "../src/license-admission.js";
import { ReviewStateStore } from "../src/state.js";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
vi.mock("../src/github.js", async (original) => ({ ...await original<object>(), GitHubApi: vi.fn(() => { throw Error("GitHub forbidden"); }) }));
vi.mock("../src/state.js", async (original) => ({ ...await original<object>(), ReviewStateStore: vi.fn(() => { throw Error("DB forbidden"); }) }));
vi.mock("../src/license-admission.js", async (original) => ({ ...await original<object>(), requireActiveProductionLicense: vi.fn(() => { throw Error("license forbidden"); }) }));
vi.mock("../src/codex-runtime.js", async (original) => {
  const actual = await original<typeof import("../src/codex-runtime.js")>();
  // CI has no Codex CLI: stub its availability check and read confinement.
  return { ...actual,
    resolveCheckoutReadsStatus: vi.fn((input: { checkoutReads?: boolean }) => ({ status: input.checkoutReads === true ? "enabled" : "disabled" })),
    runCodexReview: vi.fn(async (input, dependencies) => actual.runCodexReview(input, {
    ...dependencies,
    resolveReadConfinement: (cwd: string) => ({ command: "/fixture/codex", readableRoots: [cwd] }),
    runProcess: async (invocation) => {
      fs.writeFileSync(invocation.outputPath, JSON.stringify({ findings, summary: {
        changedBehavior: [], invariants: [], evidence: [], limitations: ["fixture"], noFindingRationale: "fixture"
      } }));
      return { stdout: "", stderr: "tokens used\n123\n", status: 0, signal: null };
    }
  })) };
});
let findings: object[] = [];
let root: string, repo: string, base: string, head: string;
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const args = () => ({ "repo-path": repo, base, repo: "fixture/repo", "pr-number": "7", title: "Fixture", out: join(root, "result.json") });
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), "nd-review-local-")); repo = join(root, "repo"); fs.mkdirSync(repo);
  git("init", "-q"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(join(repo, "file.ts"), "old\n"); git("add", "."); git("commit", "-qm", "base"); base = git("rev-parse", "HEAD");
  fs.writeFileSync(join(repo, "file.ts"), "new\n"); git("commit", "-qam", "head"); head = git("rev-parse", "HEAD");
  findings = [{ severity: "P2", path: "file.ts", line: 1, title: "Broken value", body: "This breaks the caller.", confidence: 0.99, category: "runtime_correctness", why_this_matters: "Calls fail." }];
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("runs the real parser and gate without GitHub, license or state and atomically writes comments", async () => {
  const rename = vi.mocked(fs.renameSync);
  await runReviewLocal(args());
  expect(JSON.parse(fs.readFileSync(args().out, "utf8"))).toMatchObject([{ path: "file.ts", line: 1 }]);
  expect(rename).toHaveBeenCalledWith(expect.stringContaining(".tmp-"), args().out);
  expect(fs.readdirSync(root).some(x => x.includes(".tmp-"))).toBe(false);
  expect(GitHubApi).not.toHaveBeenCalled(); expect(ReviewStateStore).not.toHaveBeenCalled(); expect(requireActiveProductionLicense).not.toHaveBeenCalled();
  // Checkout reads default on from 1.1.0 (#1184); the module mock reports them available.
  expect(runCodexReview).toHaveBeenCalledWith(expect.objectContaining({ cwd: repo, checkoutReads: true }), expect.any(Object));
  const before = fs.readFileSync(args().out, "utf8");
  rename.mockImplementationOnce(() => { throw Error("atomic rename failure"); });
  await expect(runReviewLocal(args())).rejects.toThrow("atomic rename failure");
  expect(fs.readFileSync(args().out, "utf8")).toBe(before);
  expect(fs.readdirSync(root).some(x => x.includes(".tmp-"))).toBe(false);
});
it("maps final comments and Codex usage to ReviewBench; an empty result succeeds", async () => {
  await runReviewLocal({ ...args(), format: "reviewbench", agent: "fixture" });
  const output = JSON.parse(fs.readFileSync(args().out, "utf8"));
  expect(output).toMatchObject({ pr: { repo: "https://github.com/fixture/repo", pr_number: 7, base, head }, agent: "fixture", usage: { total_tokens: 123 } });
  expect(output.findings).toEqual([{ file: "file.ts", start_line: 1, end_line: 1, message: "Broken value. This breaks the caller. Why this matters: Calls fail.", producer: "fixture" }]);
  findings = []; await runReviewLocal({ ...args(), format: "reviewbench" });
  expect(JSON.parse(fs.readFileSync(args().out, "utf8")).findings).toEqual([]);
});
it("reads every RB input and prints applied settings", async () => {
  const pr = join(root, "pr.json"), diff = join(root, "diff.patch");
  fs.writeFileSync(pr, JSON.stringify({ nwo: "fixture/repo", pr_number: 7, title: "RB title", body: "RB body", base, head }));
  fs.writeFileSync(diff, git("diff", `${base}...${head}`)); findings = [];
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runReviewLocal({ "reviewbench-env": "true", format: "reviewbench" }, {
    RB_REPO: repo, RB_BASE: base, RB_HEAD: head, RB_DIFF: diff, RB_PR_JSON: pr, RB_NWO: "fixture/repo", RB_PR_NUMBER: "7", RB_OUT: args().out,
    RB_AGENT: "rb", RB_CONFIG_MODEL: "gpt-6.1-sol", RB_CONFIG_REASONING: "medium", RB_CONFIG_CHECKOUT_READS: "true"
  });
  expect(log).toHaveBeenCalledWith("model=gpt-6.1-sol effort=medium checkout_reads=true");
  expect(runCodexReview).toHaveBeenCalledWith(expect.objectContaining({ checkoutReads: true, reasoningEffort: "medium", prompt: expect.stringContaining("RB title") }), expect.any(Object));
  expect(JSON.parse(fs.readFileSync(args().out, "utf8")).agent).toBe("rb");
});
it("falls back to a diff-only review when checkout reads are unavailable", async () => {
  vi.mocked(resolveCheckoutReadsStatus).mockReturnValueOnce({ status: "unavailable:codex_version", detail: "Codex CLI 0.162.0 is older than 0.163.0" });
  const config = join(root, "config.json"); fs.writeFileSync(config, JSON.stringify({ codexRuntime: { checkoutReads: true } }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {}), warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await runReviewLocal({ ...args(), config });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("unavailable:codex_version"));
  expect(log).toHaveBeenCalledWith(expect.stringContaining("checkout_reads=false"));
  const input = vi.mocked(runCodexReview).mock.calls[0]![0];
  expect(input.checkoutReads).toBe(false); expect(input.prompt).not.toContain("read-only checkout of");
});
it("fails head mismatch before runtime or output and returns a nonzero CLI exit", async () => {
  await expect(runReviewLocal({ ...args(), head: base })).rejects.toThrow(/head.*mismatch/i);
  expect(runCodexReview).not.toHaveBeenCalled(); expect(fs.existsSync(args().out)).toBe(false);
  const result = spawnSync(process.execPath, [resolve("node_modules/tsx/dist/cli.mjs"), "src/cli.ts", "review-local", "--repo-path", repo, "--base", base, "--head", base, "--out", args().out], { encoding: "utf8", timeout: 15000 });
  expect(result.status).toBe(1); expect(result.stderr).toMatch(/head.*mismatch/i);
});
it("removes markdown severity, collapses whitespace, includes why and caps messages", () => {
  expect(reviewBenchMessage({ title: "**[P1] Broken**", body: "**P1: **[P1] Broken****\n\nBad  value\n\nCategory: Runtime correctness\n\nWhy this matters: Failure." })).toBe("Broken. Bad value Why this matters: Failure.");
  expect(reviewBenchMessage({ title: "[P2] Long", body: "x".repeat(2000) })).toHaveLength(1500);
});
it("parses renamed, added, deleted, binary and quoted paths", () => {
  const diff = 'diff --git a/old b/new\nrename from old\nrename to new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/gone b/gone\n--- a/gone\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\ndiff --git "a/sp\\tace" "b/sp\\tace"\n--- /dev/null\n+++ "b/sp\\tace"\n@@ -0,0 +1 @@\n+hi\ndiff --git a/image b/image\nBinary files a/image and b/image differ\n';
  expect(parseLocalDiff(diff).map(x => [x.filename, x.status])).toEqual([["new", "renamed"], ["gone", "removed"], ["sp\tace", "added"], ["image", "modified"]]);
});
it("drops the tab Git appends to unquoted ---/+++ paths that contain a space", () => {
  const diff = 'diff --git a/foo bar b/foo bar\n--- a/foo bar\t\n+++ b/foo bar\t\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/new file b/new file\nnew file mode 100644\n--- /dev/null\n+++ b/new file\t\n@@ -0,0 +1 @@\n+hi\n';
  expect(parseLocalDiff(diff).map(x => [x.filename, x.status])).toEqual([["foo bar", "modified"], ["new file", "added"]]);
});
it("honors chunk budgeting locally and preserves only findings from each chunk", async () => {
  fs.writeFileSync(join(repo, "two.ts"), "hi\n"); git("add", "."); git("commit", "-qm", "two");
  const config = join(root, "config.json"), diff = join(root, "big.patch");
  fs.writeFileSync(config, JSON.stringify({ codexRuntime: { contextWindowTokens: 9000 }, contextBudget: { overflow: "chunk", reservedOutputTokens: 10 } }));
  const patch = (name: string) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${"a".repeat(11000)}\n+${"b".repeat(11000)}\n`;
  fs.writeFileSync(diff, patch("file.ts") + patch("two.ts"));
  await runReviewLocal({ ...args(), config, "diff-file": diff });
  expect(runCodexReview).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fs.readFileSync(args().out, "utf8"))).toHaveLength(1);
});
it("decodes every Git C-style path escape, including bell and vertical tab", () => {
  const diff = 'diff --git "a/x\\ay\\vz\\b\\f\\r\\n\\"\\\\\\303\\251" "b/x\\ay\\vz\\b\\f\\r\\n\\"\\\\\\303\\251"\n--- /dev/null\n+++ "b/x\\ay\\vz\\b\\f\\r\\n\\"\\\\\\303\\251"\n@@ -0,0 +1 @@\n+hi\n';
  expect(parseLocalDiff(diff).map(x => x.filename)).toEqual(["x\x07y\x0bz\b\f\r\n\"\\é"]);
  expect(() => parseLocalDiff('diff --git "a/\\q" "b/\\q"\n--- /dev/null\n+++ "b/\\q"\n')).toThrow(/escape/);
});
it("applies the configured repository profile's path filters and prompt guidance", async () => {
  fs.writeFileSync(join(repo, "two.ts"), "hi\n"); git("add", "."); git("commit", "-qm", "two"); head = git("rev-parse", "HEAD");
  const config = join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ repoProfiles: { repos: { "fixture/repo": { pathFilters: ["!two.ts"], pathInstructions: { "file.ts": ["Check the caller contract."] } } } } }));
  await runReviewLocal({ ...args(), config });
  const prompt = vi.mocked(runCodexReview).mock.calls[0]![0].prompt;
  expect(prompt).toContain("Check the caller contract."); expect(prompt).toContain("### file.ts"); expect(prompt).not.toContain("### two.ts");
  vi.mocked(runCodexReview).mockClear();
  fs.writeFileSync(config, JSON.stringify({ repoProfiles: { repos: { "other/repo": {} } } }));
  await runReviewLocal({ ...args(), config });
  expect(vi.mocked(runCodexReview).mock.calls[0]![0].prompt).toContain("### two.ts");
});
it("rejects an evidence directory inside the reviewed checkout before running", async () => {
  for (const dir of [join(repo, ".neondiff/evidence"), repo]) {
    await expect(runReviewLocal({ ...args(), "evidence-dir": dir })).rejects.toThrow(/outside the reviewed checkout/);
  }
  expect(runCodexReview).not.toHaveBeenCalled(); expect(fs.existsSync(join(repo, ".neondiff"))).toBe(false);
  fs.mkdirSync(join(repo, "inside")); fs.symlinkSync(join(repo, "inside"), join(root, "link"));
  await expect(runReviewLocal({ ...args(), "evidence-dir": join(root, "link") })).rejects.toThrow(/outside the reviewed checkout/);
  expect(runCodexReview).not.toHaveBeenCalled(); expect(fs.readdirSync(join(repo, "inside"))).toEqual([]);
  await runReviewLocal({ ...args(), "evidence-dir": join(root, "evidence") });
  expect(runCodexReview).toHaveBeenCalledTimes(1);
});
it("requests the LCM review assessment schema for the repository whose prompt asks for it", async () => {
  await runReviewLocal({ ...args(), repo: "electricsheephq/lcm-x" });
  expect(runCodexReview).toHaveBeenCalledWith(expect.objectContaining({ lcmReviewAssessment: true, prompt: expect.stringContaining("review_assessment") }), expect.any(Object));
  vi.mocked(runCodexReview).mockClear(); await runReviewLocal(args());
  expect(runCodexReview).toHaveBeenCalledWith(expect.objectContaining({ lcmReviewAssessment: false }), expect.any(Object));
});
