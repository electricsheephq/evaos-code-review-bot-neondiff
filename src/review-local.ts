import { buildUntrustedProviderReviewConfig, untrustedAuthorReviewProviderId } from "./public-repo-author-gate.js";
import { runUntrustedProviderReview } from "./untrusted-provider-review.js";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadConfigFromObject } from "./config.js";
import { resolveCheckoutReadsStatus, runCodexReview } from "./codex-runtime.js";
import { planContextBudget } from "./context-budget.js";
import { isLcmReviewRepository } from "./lcm-review-repository.js";
import { filterPullFilesForProfile, resolveRepoProfile } from "./repo-policy.js";
import { applyDeterministicReviewGate } from "./review-gate.js";
import { buildReviewPrompt } from "./zcode.js";
import type { Finding, PullFilePatch, PullRequestSummary, ReviewComment } from "./types.js";

// Git's C-style quoting (quote_c_style): named escapes plus octal bytes.
const GIT_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

function gitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  const bytes: number[] = [];
  for (const part of raw.slice(1, -1).match(/\\[0-7]{1,3}|\\.|[^\\]+/g) ?? []) {
    if (/^\\[0-7]/.test(part)) bytes.push(parseInt(part.slice(1), 8));
    else if (part.startsWith("\\")) {
      const byte = GIT_ESCAPES[part[1]!];
      if (byte === undefined) throw new Error(`Unsupported git path escape: ${part}`);
      bytes.push(byte);
    } else bytes.push(...Buffer.from(part));
  }
  return Buffer.from(bytes).toString("utf8");
}

export function parseLocalDiff(diff: string): PullFilePatch[] {
  return diff.split(/(?=^diff --git )/m).filter(x => x.startsWith("diff --git ")).map(section => {
    const lines = section.split("\n");
    // Escapes and plain characters are disjoint, so a quoted path cannot backtrack exponentially.
    const header = /^diff --git ("(?:\\.|[^"\\])*"|a\/.*?) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(lines[0]!);
    if (!header) throw new Error("Unsupported git diff header");
    const hunk = lines.findIndex(line => line.startsWith("@@ "));
    const metadata = hunk < 0 ? lines : lines.slice(0, hunk);
    // Git ends an unquoted ---/+++ name that contains a space with a tab.
    const headerPath = (prefix: string) => metadata.find(x => x.startsWith(prefix))?.slice(4).replace(/^([^"].*)\t$/, "$1");
    let oldHeader = header[1]!, nextHeader = header[2]!;
    // Unquoted equal names can themselves contain " b/"; split at the midpoint.
    const rest = lines[0]!.slice("diff --git ".length), length = (rest.length - 5) / 2;
    if (rest.startsWith("a/") && Number.isInteger(length)) {
      const name = rest.slice(2, 2 + length);
      if (rest === `a/${name} b/${name}`) { oldHeader = `a/${name}`; nextHeader = `b/${name}`; }
    }
    const metadataPath = (side: "from" | "to") => {
      const line = metadata.find(x => x.startsWith(`rename ${side} `) || x.startsWith(`copy ${side} `));
      return line === undefined ? undefined : gitPath(line.slice(line.indexOf(` ${side} `) + side.length + 2));
    };
    const oldMeta = metadataPath("from"), nextMeta = metadataPath("to");
    const old = headerPath("--- ") !== undefined ? gitPath(headerPath("--- ")!) : oldMeta !== undefined ? `a/${oldMeta}` : gitPath(oldHeader);
    const next = headerPath("+++ ") !== undefined ? gitPath(headerPath("+++ ")!) : nextMeta !== undefined ? `b/${nextMeta}` : gitPath(nextHeader);
    const filename = (next === "/dev/null" ? old : next).slice(2);
    const patch = hunk < 0 ? "" : lines.slice(hunk).join("\n");
    return { filename, patch, patchComplete: true,
      status: next === "/dev/null" ? "removed" : old === "/dev/null" ? "added" : old.slice(2) !== filename ? "renamed" : "modified",
      ...(old !== "/dev/null" && old.slice(2) !== filename ? { previous_filename: old.slice(2) } : {}),
      additions: patch.split("\n").filter(x => x.startsWith("+")).length,
      deletions: patch.split("\n").filter(x => x.startsWith("-")).length };
  });
}

export function reviewBenchMessage(comment: Pick<ReviewComment, "title" | "body">): string {
  const cleanTitle = (value: string) => value.replace(/^\s*\*\*|\*\*\s*$/g, "").replace(/^(?:\[P[0-3]\]|P[0-3]:)\s*/, "");
  const title = cleanTitle(comment.title);
  // Gate bodies already render the title, category and why. Strip only that wrapper.
  const body = comment.body.replace(/^\*\*P[0-3]:[^\n]*\*\*\s*/, "").replace(/\n\nCategory: [^\n]*/g, "");
  return `${title}. ${body}`.replace(/\s+/g, " ").trim().slice(0, 1500);
}

export function writeLocalJson(out: string, value: unknown): void {
  mkdirSync(dirname(out), { recursive: true });
  const temp = `${out}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    JSON.parse(readFileSync(temp, "utf8"));
    renameSync(temp, out);
    JSON.parse(readFileSync(out, "utf8"));
  } finally { rmSync(temp, { force: true }); }
}

export async function runReviewLocal(args: Record<string, string | string[] | undefined>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const started = Date.now();
  const arg = (key: string) => {
    const value = args[key];
    if (Array.isArray(value)) throw new Error(`--${key} must be supplied once`);
    return value;
  };
  const boolean = (value: string | undefined, name: string) => {
    if (value !== undefined && value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
    return value === "true";
  };
  const rb = boolean(arg("reviewbench-env"), "--reviewbench-env");
  const input = (key: string, rbKey: string) => rb ? env[rbKey] : arg(key);
  const repoPath = resolve(input("repo-path", "RB_REPO") ?? (rb ? "/work/repo" : process.cwd()));
  const git = (...options: string[]) => execFileSync("git", ["-c", `safe.directory=${repoPath}`, "-c", "core.quotePath=false", "-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-C", repoPath, ...options], { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 });
  const checkoutHead = git("rev-parse", "HEAD").trim();
  const head = input("head", "RB_HEAD") ?? checkoutHead;
  if (head !== checkoutHead) throw new Error(`review-local head mismatch: requested=${head} checkout=${checkoutHead}`);
  const base = input("base", "RB_BASE");
  if (!base || !/^[a-f0-9]{7,64}$/i.test(base)) throw new Error("review-local requires --base <sha> or RB_BASE");
  const prPath = input("pr-json", "RB_PR_JSON");
  const metadata = prPath ? JSON.parse(readFileSync(prPath, "utf8")) : {};
  const repo = input("repo", "RB_NWO") ?? metadata.nwo ?? metadata.repo?.replace(/^https:\/\/github.com\//, "");
  const number = Number(input("pr-number", "RB_PR_NUMBER") ?? metadata.pr_number);
  const title = (rb ? undefined : arg("title")) ?? metadata.title;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isSafeInteger(number) || number < 1 || typeof title !== "string") {
    throw new Error("review-local requires --pr-json or --repo owner/name --pr-number <n> --title <t>");
  }
  if ((metadata.head && metadata.head !== head) || (metadata.base && metadata.base !== base) || (metadata.pr_number && Number(metadata.pr_number) !== number) || (metadata.nwo && metadata.nwo !== repo)) throw new Error("PR metadata identity mismatch");
  const out = input("out", "RB_OUT");
  if (!out) throw new Error("review-local requires --out or RB_OUT");
  const format = arg("format") ?? "neondiff";
  if (!["neondiff", "reviewbench"].includes(format)) throw new Error("--format must be neondiff or reviewbench");
  const configPath = arg("config");
  const raw = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const model = input("model", "RB_CONFIG_MODEL"), effort = input("reasoning-effort", "RB_CONFIG_REASONING"), reads = input("checkout-reads", "RB_CONFIG_CHECKOUT_READS");
  let config = loadConfigFromObject({ ...raw, codexRuntime: { enabled: true, ...raw.codexRuntime,
    ...(model ? { model } : {}), ...(effort ? { reasoningEffort: effort } : {}), ...(reads !== undefined ? { checkoutReads: boolean(reads, "checkout_reads") } : {}) } });
  const untrusted = boolean(arg("untrusted-author"), "--untrusted-author");
  const providerId = untrustedAuthorReviewProviderId(config);
  if (untrusted && !providerId) throw new Error("--untrusted-author requires untrustedAuthorReview.mode=provider");
  if (untrusted) config = buildUntrustedProviderReviewConfig(config, providerId!);
  if (!untrusted && !config.codexRuntime?.enabled) throw new Error("review-local requires codexRuntime.enabled=true");
  const runtime = config.codexRuntime!;
  const provider = untrusted ? config.providers!.providers[providerId!]! : undefined;
  const agent = arg("agent") ?? env.RB_AGENT ?? "neondiff";
  // Decided once, as in the worker: without a supported Codex CLI or confinement the review falls back to diff-only.
  const readsStatus = untrusted ? { status: "disabled" as const } : resolveCheckoutReadsStatus({ checkoutReads: runtime.checkoutReads, probeSandbox: true, cwd: repoPath, cliPath: runtime.cliPath });
  const checkoutReads = readsStatus.status === "enabled";
  if (checkoutReads && git("status", "--porcelain=v1", "--untracked-files=all").trim()) {
    throw new Error("review-local --checkout-reads requires a clean checkout (commit/stash or use a detached worktree)");
  }
  if (readsStatus.status.startsWith("unavailable:")) console.warn(`[checkout-reads] ${readsStatus.status}: ${readsStatus.detail ?? "unavailable"}; running a diff-only review`);
  console.log(`model=${provider?.model ?? runtime.model} effort=${untrusted ? "provider" : runtime.reasoningEffort} checkout_reads=${checkoutReads}`);
  const diffPath = input("diff-file", "RB_DIFF");
  const diffFiles = parseLocalDiff(diffPath ? readFileSync(diffPath, "utf8") : git("diff", "--no-ext-diff", "--no-textconv", "--no-color", `${base}...${head}`));
  // Use the configured profile when there is one; a repo missing from (or disabled in) the registry reviews under the default.
  const configured = resolveRepoProfile(config, repo);
  const profile = configured.allowed ? configured : resolveRepoProfile({ ...config, repoProfiles: undefined }, repo);
  if (!profile.allowed) throw new Error("Default repo policy unavailable");
  const files = filterPullFilesForProfile(diffFiles, profile.profile);
  const pull: PullRequestSummary = { number, title, body: metadata.body ?? "", draft: false, html_url: `https://github.com/${repo}/pull/${number}`,
    head: { sha: head, ref: head }, base: { sha: base, ref: base, repo: { full_name: repo } } };
  const promptForFiles = (files: PullFilePatch[]) => buildReviewPrompt({ repo, pull, files, repoProfile: profile.profile,
    maxPatchBytes: config.zcode.maxPatchBytes, ...(checkoutReads ? { checkoutAccess: "shell_read_only" as const } : {}) });
  const prompt = promptForFiles(files);
  const budget = planContextBudget({ prompt, files, contextWindowTokens: untrusted ? provider?.contextWindowTokens : runtime.contextWindowTokens, config: config.contextBudget, buildPrompt: promptForFiles });
  if (budget.mode === "skip") throw new Error(`review-local ${budget.reason}`);
  const keep = boolean(arg("keep-evidence"), "--keep-evidence");
  const evidenceRoot = arg("evidence-dir") ? resolve(arg("evidence-dir")!) : tmpdir();
  const fromRepo = relative(repoPath, evidenceRoot);
  // Runtime artifacts inside the checkout would trip the runtime's own worktree write check.
  if (fromRepo !== ".." && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo)) throw new Error("--evidence-dir must be outside the reviewed checkout");
  mkdirSync(evidenceRoot, { recursive: true });
  // Repeat the check on resolved paths so a symlinked --evidence-dir cannot point back into the checkout.
  const fromRealRepo = relative(realpathSync(repoPath), realpathSync(evidenceRoot));
  if (fromRealRepo !== ".." && !fromRealRepo.startsWith(`..${sep}`) && !isAbsolute(fromRealRepo)) throw new Error("--evidence-dir must be outside the reviewed checkout");
  const evidenceDir = mkdtempSync(join(evidenceRoot, "neondiff-review-local-"));
  try {
    const findings: Finding[] = [];
    let totalTokens = 0, hasTokens = true;
    const chunks = budget.mode === "chunk" ? budget.chunks.map(x => x.files) : [files];
    for (const [index, chunk] of chunks.entries()) {
      if (git("rev-parse", "HEAD").trim() !== head) throw new Error("review-local head changed during review");
      const chunkDir = join(evidenceDir, `chunk-${index}`);
      const result = untrusted ? await runUntrustedProviderReview({ config, prompt: promptForFiles(chunk), lcmReviewAssessment: isLcmReviewRepository(repo) }) : await runCodexReview({ cwd: repoPath, prompt: promptForFiles(chunk), evidenceDir: chunkDir,
        cliPath: runtime.cliPath, model: runtime.model, reasoningEffort: runtime.reasoningEffort, checkoutReads,
        timeoutMs: runtime.timeoutMs, maxOutputBytes: runtime.maxOutputBytes, lcmReviewAssessment: isLcmReviewRepository(repo) }, {
        captureWorktreeState: () => git("status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching")
      });
      findings.push(...result.findings.filter(f => chunk.some(file => file.filename === f.path)));
      if (untrusted) { hasTokens = false; continue; }
      const usage = JSON.parse(readFileSync(join(chunkDir, "codex-usage.json"), "utf8"));
      if (typeof usage.tokensUsed === "number") totalTokens += usage.tokensUsed;
      else hasTokens = false;
    }
    if (git("rev-parse", "HEAD").trim() !== head) throw new Error("review-local head changed during review");
    const gate = applyDeterministicReviewGate({ findings, files, maxInlineComments: config.reviewGate?.maxInlineComments,
      publicConfidencePolicy: config.confidenceCalibration?.publicDisplay, requestChangesConfidenceFloors: config.reviewGate?.requestChangesConfidenceFloors,
      categoryPrecisionFloors: config.reviewGate?.categoryPrecisionFloors });
    writeLocalJson(resolve(out), format === "neondiff" ? gate.comments : {
      pr: { repo: `https://github.com/${repo}`, pr_number: number, base, head }, agent,
      findings: gate.comments.map(c => ({ file: c.path, start_line: c.line, end_line: c.line, message: reviewBenchMessage(c), producer: agent })),
      usage: { time_in_ms: Date.now() - started, ...(hasTokens ? { total_tokens: totalTokens } : {}) }
    });
  } finally { if (!keep) rmSync(evidenceDir, { recursive: true, force: true }); }
}
