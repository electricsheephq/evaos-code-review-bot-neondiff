#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readCorpus(root, set = "test") {
  if (!["test", "full"].includes(set)) throw Error("--set must be test or full");
  const path = join(root, set === "test" ? "corpus/test/test.json" : "corpus/manifest.json");
  const tasks = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(tasks) || !tasks.length || tasks.some(t => !t ||
    !/^[\w.-]+\/[\w.-]+$/.test(t.nwo ?? "") || t.nwo.split("/").some(x => x === "." || x === "..") ||
    t.repo !== `https://github.com/${t.nwo}` || !Number.isSafeInteger(t.pr_number) || t.pr_number < 1 ||
    ![t.base, t.head].every(x => typeof x === "string" && /^[a-f0-9]{40,64}$/i.test(x)) ||
    typeof t.title !== "string" || typeof t.body !== "string")) throw Error(`Unexpected ReviewBench corpus shape: ${path}`);
  return tasks;
}

export function writeFindingsFile(out, task, agent, findings, usage) {
  if (!Array.isArray(findings) || findings.some(f => !f || typeof f.file !== "string" || !f.file ||
    f.file.startsWith("/") || f.file.includes("\\") || f.file.split("/").some(p => ["", ".", ".."].includes(p)) ||
    !Number.isSafeInteger(f.start_line) || f.start_line < 1 || !Number.isSafeInteger(f.end_line) || f.end_line < f.start_line || typeof f.message !== "string")) throw Error("Invalid ReviewBench finding");
  const value = { pr: { repo: task.repo, pr_number: task.pr_number, base: task.base, head: task.head }, agent,
    findings: findings.map(f => ({ file: f.file, start_line: f.start_line, end_line: f.end_line, message: f.message, producer: agent })), usage };
  mkdirSync(dirname(out), { recursive: true });
  const temp = `${out}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    JSON.parse(readFileSync(temp, "utf8")); renameSync(temp, out); JSON.parse(readFileSync(out, "utf8"));
  } finally { rmSync(temp, { force: true }); }
}

export const nativePrompt = t => `Review the change between ${t.base} and ${t.head} in this repository (the diff is in diff.patch). Report real defects introduced by the change: file, start_line, end_line at head, and a message that says what is wrong and why. Report nothing if there are none.`;
const nativeSchema = { type: "object", additionalProperties: false, required: ["findings"], properties: {
  findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "start_line", "end_line", "message"], properties: {
    file: { type: "string" }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 }, message: { type: "string" }
  } } }
} };

async function main(argv) {
  const options = {};
  const keys = ["reviewbench", "set", "limit", "pr", "run", "cache", "arm", "model", "reasoning-effort", "checkout-reads"];
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2), value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !keys.includes(key) || !value || value.startsWith("--") || options[key] !== undefined) throw Error(`Invalid runner option: ${argv[i]}`);
    options[key] = value;
  }
  if (!options.reviewbench || !options.run) throw Error("Required: --reviewbench <clone> --run <new directory>");
  const arm = options.arm ?? "neondiff", model = options.model ?? "gpt-6.1-sol", effort = options["reasoning-effort"] ?? "high", reads = options["checkout-reads"] ?? "false";
  if (!["neondiff", "codex-native"].includes(arm) || !["low", "medium", "high", "xhigh", "max"].includes(effort) || !["true", "false"].includes(reads)) throw Error("Invalid arm, reasoning-effort or checkout-reads");
  const effectiveReads = arm === "neondiff" ? reads : "checkout";
  let tasks = readCorpus(resolve(options.reviewbench), options.set ?? "test");
  for (const key of ["pr", "limit"]) if (options[key] !== undefined && (!/^\d+$/.test(options[key]) || !Number.isSafeInteger(Number(options[key])) || Number(options[key]) < (key === "pr" ? 0 : 1))) throw Error(`Invalid --${key}`);
  if (options.pr !== undefined) {
    const task = tasks[Number(options.pr)]; if (!task) throw Error("--pr index outside corpus"); tasks = [task];
  }
  if (options.limit) tasks = tasks.slice(0, Number(options.limit));
  const run = resolve(options.run), cache = resolve(options.cache ?? join(dirname(run), "mirror-cache"));
  mkdirSync(run); mkdirSync(cache, { recursive: true }); mkdirSync(join(run, "findings"));
  writeFileSync(join(run, "settings.json"), JSON.stringify({ arm, model, effort, checkout_reads: effectiveReads, set: options.set ?? "test", tasks }, null, 2));
  const cli = fileURLToPath(new URL("../../dist/src/cli.js", import.meta.url));
  console.log(`arm=${arm} model=${model} effort=${effort} checkout_reads=${effectiveReads}`);
  const runtime = arm === "codex-native" ? await import("../../dist/src/codex-runtime.js") : undefined;
  let failed = 0;
  for (const task of tasks) {
    const id = `${task.nwo.replace("/", "_")}_${task.pr_number}-${task.head.slice(0, 8)}`, started = Date.now();
    const dir = join(run, "tasks", id), checkout = join(dir, "repo"), mirror = join(cache, `${task.nwo.replace("/", "_")}.git`);
    const out = join(run, "findings", `${id}.json`);
    let status = 0, tokens = null;
    mkdirSync(dir, { recursive: true });
    const git = (cwd, ...args) => execFileSync("git", ["-c", `safe.directory=${cwd}`, "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-C", cwd, ...args], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024, timeout: 120000, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    try {
      if (!existsSync(mirror)) { mkdirSync(mirror); git(mirror, "init", "--bare", "-q"); }
      const hasCommits = () => { try { for (const sha of [task.base, task.head]) git(mirror, "cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; } };
      const fetch = (url, refs) => { try { git(mirror, "fetch", "-q", url, ...refs); } catch { /* Next fallback checks actual objects. */ } };
      if (!hasCommits()) fetch(`https://github.com/review-bench/${task.nwo.replace("/", "_")}.git`, [task.base, task.head]);
      if (!hasCommits()) fetch(`${task.repo}.git`, [task.base, `pull/${task.pr_number}/head`]);
      if (!hasCommits()) fetch(`${task.repo}.git`, [task.base, task.head]);
      if (!hasCommits()) throw Error("Could not fetch base and head from mirror or upstream");
      // A worktree from an interrupted run stays registered after its directory is gone; clear it first.
      git(mirror, "worktree", "prune");
      git(mirror, "worktree", "add", "--detach", checkout, task.head);
      const diff = git(checkout, "diff", "--no-ext-diff", "--no-textconv", "--no-color", `${task.base}...${task.head}`);
      const diffPath = join(dir, "diff.patch"), prPath = join(dir, "pr.json");
      writeFileSync(diffPath, diff); writeFileSync(prPath, JSON.stringify(task));
      if (arm === "neondiff") {
        const result = spawnSync(process.execPath, [cli, "review-local", "--reviewbench-env", "--format", "reviewbench", "--evidence-dir", join(dir, "evidence"), "--keep-evidence"], {
          cwd: checkout, encoding: "utf8", timeout: 660000, maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, RB_REPO: checkout, RB_BASE: task.base, RB_HEAD: task.head, RB_DIFF: diffPath, RB_PR_JSON: prPath, RB_NWO: task.nwo,
            RB_PR_NUMBER: String(task.pr_number), RB_AGENT: arm, RB_OUT: out, RB_CONFIG_MODEL: model, RB_CONFIG_REASONING: effort, RB_CONFIG_CHECKOUT_READS: reads }
        });
        writeFileSync(join(dir, "stdout.txt"), result.stdout ?? "");
        // CLI errors are redacted at its boundary; never retain the parent environment.
        writeFileSync(join(dir, "stderr.txt"), result.stderr ?? "");
        status = result.status ?? 1; if (status) throw Error(`review-local failed (exit ${status})`);
        const output = JSON.parse(readFileSync(out, "utf8"));
        if (output.pr?.head !== task.head || output.pr?.pr_number !== task.pr_number) throw Error("Findings identity mismatch");
        tokens = output.usage?.total_tokens ?? null;
        writeFindingsFile(out, task, arm, output.findings, output.usage);
      } else {
        if (existsSync(join(checkout, "diff.patch"))) throw Error("Native diff.patch would overwrite a corpus file");
        writeFileSync(join(checkout, "diff.patch"), diff, { flag: "wx" });
        const prompt = nativePrompt(task); writeFileSync(join(dir, "prompt.txt"), prompt);
        const result = await runtime.runCodexStructuredOutput({ cwd: checkout, prompt, cliPath: "codex", model, reasoningEffort: effort, evidenceDir: dir,
          timeoutMs: 600000, maxOutputBytes: 20 * 1024 * 1024, artifactPrefix: "codex-native", schema: nativeSchema, parse: value => value,
          // Corpus PRs are untrusted input: confine the native arm's reads to the checkout, as NeonDiff's are.
          confineReadsToCheckout: true }, {
          captureWorktreeState: () => git(checkout, "status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")
        });
        const { readdirSync } = await import("node:fs");
        const usageFile = readdirSync(dir).find(name => name.startsWith("codex-usage-codex-native-"));
        tokens = JSON.parse(readFileSync(join(dir, usageFile), "utf8")).tokensUsed;
        writeFindingsFile(out, task, arm, result.value.findings, { time_in_ms: Date.now() - started, ...(tokens === null ? {} : { total_tokens: tokens }) });
      }
    } catch (error) {
      status ||= 1; failed++;
      console.error(`${id}: FAIL (${status})`);
      writeFileSync(join(dir, "failure.txt"), error instanceof Error ? error.message.split("\n")[0] : "Task failed");
    }
    appendFileSync(join(run, "runs.jsonl"), `${JSON.stringify({ task_id: id, arm, exit_status: status, time_in_ms: Date.now() - started, total_tokens: tokens })}\n`);
  }
  console.log(`passed ${tasks.length - failed}, failed ${failed}; findings in ${join(run, "findings")}`);
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
