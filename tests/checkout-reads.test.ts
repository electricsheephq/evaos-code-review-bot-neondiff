import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCodexExecInvocation, CODEX_REVIEW_FINDINGS_JSON_SCHEMA, CODEX_CHECKOUT_REVIEW_FINDINGS_JSON_SCHEMA, codexCliVersionAtLeast, parseCodexCliVersion, parseCodexCommands, resolveCheckoutReadsStatus, resolveCodexReadConfinement, resolveTrustedCodexPath, runCodexReview } from "../src/codex-runtime.js";
import { buildSkillPackContextPacket } from "../src/skill-packs.js";
import { createSourceRefReadBudget, verifySourceRef } from "../src/issue-analysis.js";
import { loadConfigFromObject } from "../src/config.js";
import { buildFindingFingerprint, parseFindings } from "../src/findings.js";
import { buildReviewPrompt, reviewPromptForbiddenFragments } from "../src/zcode.js";
import type { PullRequestSummary } from "../src/types.js";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "checkout-reads-")); roots.push(path); return path; };
const fixture = (name: string) => readFileSync(new URL(`./fixtures/checkout-reads/${name}`, import.meta.url), "utf8");
const finding = { severity: "P1", path: "review.ts", line: 1, title: "Fixture defect", body: "Fixture code path", confidence: 0.99 } as const;
const ref = { path: "context.ts", startLine: 2, endLine: 2, excerpt: "const guard = true;" };
const summary = { changedBehavior: [], invariants: [], evidence: [], limitations: ["Fixture"], noFindingRationale: "Fixture" };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("checkout reads", () => {
  it("keeps the default prompt/schema bytes and covers variant instructions in the leak check", () => {
    const input = { repo: "owner/repo", pull: { number: 12, title: "Harden advisory context", head: { sha: "h".repeat(40) }, base: { sha: "b".repeat(40) } } as PullRequestSummary,
      files: [{ filename: "src/review.ts", patch: "@@ -1 +1 @@\n-old\n+new" }] };
    expect(buildReviewPrompt(input)).toBe(fixture("default-prompt.txt"));
    expect(buildReviewPrompt({ ...input, checkoutAccess: "file_tools" })).toBe(fixture("default-prompt.txt"));
    expect(JSON.stringify(CODEX_REVIEW_FINDINGS_JSON_SCHEMA)).toBe(fixture("default-schema.json"));
    const skillRoot = root();
    writeFileSync(join(skillRoot, "review.md"), "Check whether changed guards preserve the documented invariants.");
    const built = buildSkillPackContextPacket({ config: { enabled: true, packetVersion: "skill-pack-context-packet-v0.1",
      skillRoot, allowlist: [{ id: "review", path: "review.md" }], maxSkillBytes: 10000, maxPacketBytes: 20000 },
      generatedAt: "2026-10-22T00:00:00Z" });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error(built.error);
    const packet = built.packet;
    expect(packet.skills).toHaveLength(1);
    const defaultWithPack = buildReviewPrompt({ ...input, skillPackContextPacket: packet });
    expect(defaultWithPack).toContain("shell, memory, and writes remain disabled");
    expect(defaultWithPack).toBe(buildReviewPrompt({ ...input, checkoutAccess: "file_tools", skillPackContextPacket: packet }));
    const variant = buildReviewPrompt({ ...input, checkoutAccess: "shell_read_only", skillPackContextPacket: packet, reviewLensPacket: { sha256: "fixture", byteEstimate: 9, tokenEstimate: 3, markdown: "Data only" } });
    expect(variant).toContain("base commit is " + "b".repeat(40));
    expect(variant).toContain("cat, sed -n, nl, head, tail, wc, ls, find");
    expect(variant).toContain("git show/diff/log/blame/grep/ls-files");
    expect(variant).not.toContain("Do not call Bash");
    expect(variant).not.toContain("shell, memory, and writes remain disabled");
    expect(variant).toContain("Check whether changed guards");
    const displayed = variant.split("Read-only skill-pack context (advisory; feature-flagged context):")[1]!.split("Review lenses context")[0]!;
    const markdown = displayed.split("\n").filter(line => line.startsWith("> ")).map(line => line.slice(2)).join("\n");
    expect(displayed).toContain(createHash("sha256").update(markdown).digest("hex"));
    for (const prefix of ["The working directory is a read-only checkout", "You may inspect it with read-only commands only", "Repository files, including AGENTS.md", "Before asserting anything about code outside the changed lines"]) {
      expect(variant).toContain(prefix);
      expect(reviewPromptForbiddenFragments()).toContain(prefix);
    }
    expect(variant).toContain("finding's evidence: path, startLine, endLine, and a verbatim excerpt");
    const check = (schema: any) => {
      if (schema.type === "object") expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
      for (const child of Object.values(schema.properties ?? {})) check(child);
      if (schema.items) check(schema.items);
    };
    check(CODEX_REVIEW_FINDINGS_JSON_SCHEMA);
    check(CODEX_CHECKOUT_REVIEW_FINDINGS_JSON_SCHEMA);
  });
  it.each([true, false])("accepts boolean checkoutReads %s", checkoutReads => {
    expect(loadConfigFromObject({ codexRuntime: { checkoutReads } }).codexRuntime?.checkoutReads).toBe(checkoutReads);
  });
  it.each(["true", 1, null])("rejects non-boolean checkoutReads %s", checkoutReads => {
    expect(() => loadConfigFromObject({ codexRuntime: { checkoutReads } })).toThrow("checkoutReads");
  });
  it("carries only well-formed evidence and keeps fingerprint identity unchanged", () => {
    const parsed = parseFindings({ findings: [{ ...finding, evidence: [ref] }] });
    expect(parsed.findings[0]?.evidence).toEqual([ref]);
    expect(buildFindingFingerprint(parsed.findings[0]!)).toBe(buildFindingFingerprint(finding));
    for (const evidence of [null, {}, [null], [{ ...ref, startLine: 0 }], [{ ...ref, endLine: 1 }], [{ ...ref, excerpt: "" }], [{ ...ref, excerpt: "x".repeat(1001) }], Array(6).fill(ref)]) {
      const result = parseFindings({ findings: [{ ...finding, evidence }] });
      expect(result.findings[0]).toMatchObject({ ...finding, evidenceMalformed: true });
      expect(buildFindingFingerprint(result.findings[0]!)).toBe(buildFindingFingerprint(finding));
      expect(result.dropped).toEqual([]);
    }
  });
  it("returns per-reference failure codes without throwing", () => {
    const cwd = root(), outside = root();
    writeFileSync(join(cwd, "context.ts"), "// outside the diff\nconst guard = true;\n");
    writeFileSync(join(outside, "external.ts"), "external");
    symlinkSync(join(outside, "external.ts"), join(cwd, "escape.ts"));
    expect(verifySourceRef(cwd, ref)).toBeNull();
    for (const [source, code] of [
      [{ ...ref, path: "../" + outside.split("/").at(-1) + "/external.ts" }, "path_escapes"],
      [{ ...ref, path: "escape.ts" }, "path_escapes"],
      [{ ...ref, path: "missing.ts" }, "path_missing"],
      [{ ...ref, path: "././context.ts" }, "non_canonical"],
      [{ ...ref, endLine: 100 }, "range_out_of_bounds"],
      [{ ...ref, excerpt: "false claim" }, "excerpt_mismatch"],
      [{ ...ref, path: "." }, "path_escapes"]
    ] as const) expect(verifySourceRef(cwd, source)).toBe(code);
  });
  it.each([true, false])("drops false citations per finding only when enabled=%s and always writes audit", async checkoutReads => {
    const cwd = root();
    writeFileSync(join(cwd, "context.ts"), "// not in diff\nconst guard = true;\n");
    const findings = [{ ...finding, evidence: [{ ...ref, excerpt: "false" }] },
      { ...finding, title: "Valid citation", evidence: [ref] }, { ...finding, title: "Diff only", evidence: [] }];
    const result = await runCodexReview({ cwd, evidenceDir: join(cwd, "evidence"), prompt: "Fixture", cliPath: "/fixture/codex", model: "gpt-6.1-sol", reasoningEffort: "high", timeoutMs: 1000, maxOutputBytes: 100000, checkoutReads }, {
      captureWorktreeState: () => "unchanged", resolveReadConfinement: () => ({ command: "/fixture/codex", readableRoots: [cwd] }), runProcess: async invocation => {
        writeFileSync(invocation.outputPath, JSON.stringify({ findings, summary }));
        return { stdout: "", stderr: `user\n${invocation.stdin}\n${fixture("codex-v0163-stderr.txt")}`, status: 0, signal: null };
      }
    });
    expect(result.droppedFromSchema).toEqual([]);
    expect(result.findings).toHaveLength(checkoutReads ? 2 : 3);
    if (checkoutReads) expect(result.droppedFromEvidence).toMatchObject([{ reason: "evidence_unverified", evidenceFailure: "excerpt_mismatch" }]);
    else { expect(result.droppedFromEvidence).toBeUndefined(); expect(result.findings.every(f => f.evidence === undefined)).toBe(true); }
    expect(JSON.parse(readFileSync(join(cwd, "evidence/codex-commands.json"), "utf8"))).toMatchObject({ counts: { total: 1, flagged: 1 } });
  });
  it.each([true, false])("drops malformed evidence only when checkoutReads=%s", async checkoutReads => {
    const cwd = root();
    writeFileSync(join(cwd, "context.ts"), "// outside diff\nconst guard = true;\n");
    const malformed = [null, {}, [ref, { ...ref, endLine: 1 }], [{ ...ref, endLine: 1 }],
      [{ ...ref, excerpt: "x".repeat(1001) }], Array(6).fill(ref)];
    const result = await runCodexReview({ cwd, evidenceDir: join(cwd, "evidence"), prompt: "Fixture", cliPath: "/fixture/codex",
      model: "gpt-6.1-sol", reasoningEffort: "high", timeoutMs: 1000, maxOutputBytes: 100000, checkoutReads }, {
      captureWorktreeState: () => "unchanged", resolveReadConfinement: () => ({ command: "/fixture/codex", readableRoots: [cwd] }), runProcess: async invocation => {
        writeFileSync(invocation.outputPath, JSON.stringify({ findings: malformed.map(evidence => ({ ...finding, evidence })), summary }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });
    expect(result.droppedFromSchema).toEqual([]);
    expect(JSON.parse(readFileSync(join(cwd, "evidence/codex-commands.json"), "utf8"))).toMatchObject({
      commands: [], parseNote: "prompt_echo_not_found"
    });
    if (checkoutReads) {
      expect(result.findings).toEqual([]);
      expect(result.droppedFromEvidence).toHaveLength(malformed.length);
      expect(result.droppedFromEvidence?.every(f => f.reason === "evidence_unverified" && f.evidenceFailure === "malformed")).toBe(true);
      expect(result.droppedFromEvidence?.[2]?.evidence).toEqual([ref]);
    } else {
      expect(result.findings).toEqual(malformed.map(() => finding));
      expect(result.droppedFromEvidence).toBeUndefined();
    }
  });
  it("drops a redacted citation as evidence_unverified while other findings survive", async () => {
    const cwd = root();
    const token = ["super", "secret", "token"].join("-");
    writeFileSync(join(cwd, "context.ts"), `// ${token}\nconst guard = true;\n`);
    const result = await runCodexReview({ cwd, evidenceDir: join(cwd, "evidence"), prompt: "Fixture", cliPath: "/fixture/codex",
      model: "gpt-6.1-sol", reasoningEffort: "high", timeoutMs: 1000, maxOutputBytes: 100000, checkoutReads: true }, {
      captureWorktreeState: () => "unchanged",
      resolveReadConfinement: () => ({ command: "/fixture/codex", readableRoots: [cwd] }),
      runProcess: async invocation => {
        writeFileSync(invocation.outputPath, JSON.stringify({ findings: [
          { ...finding, evidence: [{ ...ref, startLine: 1, endLine: 1, excerpt: `// ${token}` }] },
          { ...finding, title: "Valid citation", evidence: [ref] },
          { ...finding, title: "Diff only", evidence: [] }
        ], summary }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });
    expect(result.findings.map(f => f.title)).toEqual(["Valid citation", "Diff only"]);
    expect(result.droppedFromEvidence).toMatchObject([{ reason: "evidence_unverified", evidenceFailure: "excerpt_mismatch",
      evidence: [{ excerpt: "// [redacted-secret]" }] }]);
    expect(result.rawResponse.includes(token)).toBe(false);
  });
  it("confines checkout-read shell reads with a permission profile instead of the read-only sandbox", () => {
    const base = { cliPath: "codex", cwd: "/work/tree", model: "gpt-6.1-sol", reasoningEffort: "high" as const,
      schemaPath: "/evidence/schema.json", outputPath: "/evidence/result.json" };
    const open = buildCodexExecInvocation(base);
    expect(open.args).toContain("--sandbox");
    const confined = buildCodexExecInvocation({ ...base,
      readConfinement: { command: "/opt/codex/bin/codex", readableRoots: ["/work/tree", "/work/mirrors/r.git", "/opt/codex/bin"] } });
    expect(confined.command).toBe("/opt/codex/bin/codex");
    expect(confined.args).not.toContain("--sandbox");
    expect(confined.args).toContain('default_permissions="neondiff_checkout_read"');
    expect(confined.args).toContain('permissions.neondiff_checkout_read.filesystem={":minimal"="read", ":workspace_roots"="read", ' +
      '"/work/tree"="read", "/work/mirrors/r.git"="read", "/opt/codex/bin"="read"}');
    expect(confined.args).toContain('shell_environment_policy.set={GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1"}');
    expect(confined.args.slice(confined.args.indexOf("--cd"))).toEqual(open.args.slice(open.args.indexOf("--cd")));
  });
  it("resolves read roots to the checkout, its git mirror and the real Codex binary, and refuses CODEX_HOME", () => {
    const top = realpathSync(root());
    const bin = join(top, "release", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "codex"), "#!/bin/sh\n");
    chmodSync(join(bin, "codex"), 0o755);
    mkdirSync(join(top, "path"));
    symlinkSync(join(bin, "codex"), join(top, "path", "codex"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: top, stdio: "pipe" });
    git("init", "-q", "src");
    writeFileSync(join(top, "src", "f.txt"), "x\n");
    git("-C", "src", "add", "f.txt");
    git("-C", "src", "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init");
    git("clone", "-q", "--mirror", "src", "mirror.git");
    git("--git-dir", "mirror.git", "worktree", "add", "-q", "--detach", join(top, "wt"), "HEAD");
    const env = { PATH: `${join(top, "path")}:${process.env.PATH}`, HOME: join(top, "home") };
    expect(resolveCodexReadConfinement(join(top, "wt"), "codex", env)).toEqual({
      command: join(bin, "codex"), readableRoots: [join(top, "wt"), bin, join(top, "mirror.git")]
    });
    expect(() => resolveCodexReadConfinement(join(top, "wt"), "codex", { ...env, CODEX_HOME: bin })).toThrow("CODEX_HOME");
    expect(() => resolveCodexReadConfinement(join(top, "wt"), "codex", { PATH: join(top, "missing") })).toThrow("not found");
   }, 30_000);
  it.each([true, false])("passes read confinement to Codex only when checkoutReads=%s", async checkoutReads => {
    const cwd = root();
    let args: string[] = [];
    let resolved = 0;
    await runCodexReview({ cwd, evidenceDir: join(cwd, "evidence"), prompt: "Fixture", cliPath: "/fixture/codex", model: "gpt-6.1-sol",
      reasoningEffort: "high", timeoutMs: 1000, maxOutputBytes: 100000, checkoutReads }, {
      captureWorktreeState: () => "unchanged",
      resolveReadConfinement: () => { resolved++; return { command: "/real/codex", readableRoots: [cwd] }; },
      runProcess: async invocation => {
        args = invocation.args;
        writeFileSync(invocation.outputPath, JSON.stringify({ findings: [], summary }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });
    expect(resolved).toBe(checkoutReads ? 1 : 0);
    expect(args.includes("--sandbox")).toBe(!checkoutReads);
  });
  it("parses and compares Codex CLI versions", () => {
    expect(parseCodexCliVersion("codex-cli 0.163.0\n")).toEqual([0, 163, 0]);
    expect(parseCodexCliVersion("codex-cli 1.2.3-alpha.4")).toEqual([1, 2, 3]);
    expect(parseCodexCliVersion("codex-cli dev")).toBeUndefined();
    expect(codexCliVersionAtLeast([0, 163, 0], "0.163.0")).toBe(true);
    expect(codexCliVersionAtLeast([0, 164, 0], "0.163.0")).toBe(true);
    expect(codexCliVersionAtLeast([1, 0, 0], "0.163.0")).toBe(true);
    expect(codexCliVersionAtLeast([0, 162, 9], "0.163.0")).toBe(false);
  });
  it("decides checkout-read availability from config, CLI version and confinement", () => {
    const base = { cwd: "/work/tree", cliPath: "/fixture/codex" };
    const confine = () => ({ command: "/fixture/codex", readableRoots: ["/work/tree"] });
    const unread = () => { throw new Error("must not read the version"); };
    expect(resolveCheckoutReadsStatus({ ...base, checkoutReads: false }, { readVersion: unread })).toEqual({ status: "disabled" });
    expect(resolveCheckoutReadsStatus({ ...base, checkoutReads: true }, { readVersion: () => "codex-cli 0.163.0", resolveReadConfinement: confine }))
      .toEqual({ status: "enabled" });
    expect(resolveCheckoutReadsStatus({ ...base, checkoutReads: true }, { readVersion: () => "codex-cli 0.150.2", resolveReadConfinement: confine }))
      .toMatchObject({ status: "unavailable:codex_version", detail: expect.stringContaining("0.150.2") });
    expect(resolveCheckoutReadsStatus({ ...base, checkoutReads: true }, { readVersion: () => undefined, resolveReadConfinement: confine }).status)
      .toBe("unavailable:codex_version");
    expect(resolveCheckoutReadsStatus({ ...base, checkoutReads: true }, { readVersion: () => "codex-cli 0.163.0",
      resolveReadConfinement: () => { throw new Error("codex_runtime_read_confinement_unavailable: a readable root would expose CODEX_HOME"); } }))
      .toMatchObject({ status: "unavailable:confinement", detail: expect.stringContaining("CODEX_HOME") });
  });
  it("rechecks unsupported Codex versions after an in-place upgrade and caches supported versions", () => {
    const dir = root();
    const cli = join(dir, "codex");
    const counter = join(dir, "calls");
    writeFileSync(cli, `#!/bin/sh\necho x >> "${counter}"\necho "codex-cli 0.150.0"\n`);
    chmodSync(cli, 0o755);
    const confine = () => ({ command: cli, readableRoots: [dir] });
    for (let index = 0; index < 2; index += 1) {
      expect(resolveCheckoutReadsStatus({ checkoutReads: true, cwd: dir, cliPath: cli }, { resolveReadConfinement: confine }).status)
        .toBe("unavailable:codex_version");
    }
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(2);
    writeFileSync(cli, `#!/bin/sh\necho x >> "${counter}"\necho "codex-cli 0.163.0"\n`);
    for (let index = 0; index < 2; index += 1) expect(resolveCheckoutReadsStatus(
      { checkoutReads: true, cwd: dir, cliPath: cli }, { resolveReadConfinement: confine }).status).toBe("enabled");
    expect(readFileSync(counter, "utf8").trim().split("\n")).toHaveLength(3);
    expect(resolveCheckoutReadsStatus({ checkoutReads: true, cwd: dir, cliPath: join(dir, "missing") }, { resolveReadConfinement: confine }).status)
      .toBe("unavailable:codex_version");
  });
  it("withholds the model summary when a citation fails verification", async () => {
    const cwd = root();
    writeFileSync(join(cwd, "context.ts"), "// not in diff\nconst guard = true;\n");
    const claimed = { changedBehavior: ["Unverified caller claim"], invariants: ["Unverified invariant"], evidence: ["context.ts:9"],
      limitations: ["Fixture"], noFindingRationale: "Fixture" };
    const run = (evidence: unknown[]) => runCodexReview({ cwd, evidenceDir: join(cwd, "evidence"), prompt: "Fixture", cliPath: "/fixture/codex",
      model: "gpt-6.1-sol", reasoningEffort: "high", timeoutMs: 1000, maxOutputBytes: 100000, checkoutReads: true }, {
      captureWorktreeState: () => "unchanged", resolveReadConfinement: () => ({ command: "/fixture/codex", readableRoots: [cwd] }),
      runProcess: async invocation => {
        writeFileSync(invocation.outputPath, JSON.stringify({ findings: [{ ...finding, evidence }], summary: claimed }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });
    expect((await run([ref])).summary).toEqual(claimed);
    const withheld = (await run([{ ...ref, excerpt: "false claim" }])).summary;
    expect(JSON.stringify(withheld)).not.toContain("Unverified");
    expect(withheld).toMatchObject({ changedBehavior: [], invariants: [], evidence: [] });
    expect(withheld.limitations).toHaveLength(1);
  });
  it("reads each cited file once and bounds file size and citation count", () => {
    const cwd = root();
    writeFileSync(join(cwd, "context.ts"), "// outside the diff\nconst guard = true;\n");
    writeFileSync(join(cwd, "big.bin"), "x".repeat(1024 * 1024 + 1));
    const budget = createSourceRefReadBudget();
    expect(verifySourceRef(cwd, ref, budget)).toBeNull();
    rmSync(join(cwd, "context.ts"));
    expect(verifySourceRef(cwd, ref, budget)).toBe("path_missing");
    writeFileSync(join(cwd, "context.ts"), "// outside the diff\nconst guard = true;\n");
    expect(verifySourceRef(cwd, ref, budget)).toBeNull();
    expect(budget.bytesRead).toBe(Buffer.byteLength("// outside the diff\nconst guard = true;\n"));
    expect(verifySourceRef(cwd, { path: "big.bin", startLine: 1, endLine: 1, excerpt: "x" }, budget)).toBe("citation_budget_exceeded");
    expect(verifySourceRef(cwd, { path: "big.bin", startLine: 1, endLine: 1, excerpt: "x" })).toBeNull();
    const flood = { ...createSourceRefReadBudget(), maxCitations: 2 };
    expect([1, 2, 3].map(() => verifySourceRef(cwd, ref, flood))).toEqual([null, null, "citation_budget_exceeded"]);
  });
  it("parses the captured v0.163 exec block and audits read commands and executable commands", () => {
    expect(parseCodexCommands(fixture("codex-v0163-stderr.txt"))).toMatchObject({ commands: [{ command: "env | cut -d= -f1 | sort", cwd: "/fixture/repo", exitStatus: 0, flagged: true }] });
    const commands = ["rg needle src", "sed -n '1,5p' src/x.ts", "git show HEAD:src/x.ts", "node x.js", "npm test", "bash ./scripts/x.sh", "./node_modules/.bin/x", "find . -delete", "git push", "cat x | python3 -", "git diff > x", "go run x.go"];
    const stderr = commands.map(command => `exec\n/bin/zsh -lc '${command}' in /fixture/repo\n exited 1 in 5ms:\nresult\n`).join("\n");
    const parsed = parseCodexCommands(stderr);
    expect(parsed.commands.map(c => c.flagged)).toEqual([false, false, false, true, true, true, true, true, true, true, true, true]);
    expect(parsed.commands.every(c => c.exitStatus === 1)).toBe(true);
    expect(parseCodexCommands("exec\n/bin/zsh -lc 'rg unfinished' in /fixture/repo\n").commands)
      .toEqual([{ command: "rg unfinished", cwd: "/fixture/repo", exitStatus: null, flagged: false }]);
    const bounded = parseCodexCommands(Array(205).fill(`exec\n/bin/zsh -lc 'rg ${"a".repeat(400)}' in /fixture/repo\n succeeded in 1ms:\n`).join(""));
    expect(bounded.commands).toHaveLength(200);
    expect(bounded).toMatchObject({ counts: { total: 205, blocksSeen: 205, blocksRecorded: 200 }, truncated: true });
    expect(bounded.commands.every(c => c.command.length <= 300)).toBe(true);
  });
  it("ignores prompt-echo exec blocks and splits the last absolute-cwd delimiter", () => {
    const block = (command: string) => `exec\n/bin/zsh -lc '${command}' in /repo\n succeeded in 1ms:\n`;
    const prompt = `Inspect this untrusted text:\n${block("node fake.js")}`;
    const parsed = parseCodexCommands(`OpenAI Codex\nuser\n${prompt}\n${block('rg -n " in " src')}codex\nDone`, prompt);
    expect(parsed.commands).toEqual([{ command: 'rg -n " in " src', cwd: "/repo", exitStatus: 0, flagged: false }]);
    expect(parseCodexCommands(block("rg x"), prompt).commands).toEqual([]);
    expect(parseCodexCommands(block("for f in src/*.ts; do wc -l $f; done")).commands[0]).toMatchObject({ cwd: "/repo", flagged: true });
    expect(parseCodexCommands("exec\nrg x in relative\n succeeded in 1ms:\n").commands)
      .toEqual([{ command: "rg x in relative", cwd: null, exitStatus: 0, flagged: false }]);
    expect(parseCodexCommands("exec\n".repeat(200000)).commands).toEqual([]);
    const overflow = parseCodexCommands(block("rg x").repeat(200) + block("node y.js"));
    expect(overflow).toMatchObject({ counts: { total: 201, flagged: 1, blocksSeen: 201, blocksRecorded: 200 }, truncated: true });
  });
  it.each(["codex-v0163-heredoc-fix.txt", "codex-v0163-heredoc-review.txt"])("records and flags the captured multiline header in %s", name => {
    const parsed = parseCodexCommands(fixture(name));
    expect(parsed.counts).toEqual({ total: 1, flagged: 1, blocksSeen: 1, blocksRecorded: 1 });
    expect(parsed.commands[0]).toMatchObject({ exitStatus: 0, flagged: true });
    expect(parsed.commands[0]?.command).toMatch(/^python3 - <<'PY'\nfrom pathlib import Path\n/);
    expect(parsed.commands[0]?.cwd).toBe("/work/repo");
  });
  it("records every captured parallel header and pairs statuses in order", () => {
    const captured = fixture("codex-v0163-parallel.txt");
    const parsed = parseCodexCommands(captured);
    expect(parsed.counts).toEqual({ total: 4, flagged: 0, blocksSeen: 4, blocksRecorded: 4 });
    expect(parsed.commands.map(c => c.exitStatus)).toEqual([0, 0, 0, 0]);
    expect(parsed.commands.map(c => c.command.split(" ")[0])).toEqual(["cat", "cat", "sed", "sed"]);
    const headers = captured.slice(0, captured.indexOf(" succeeded"));
    const partial = parseCodexCommands(headers + " exited -9 in 2ms:\noutput\n succeeded in 3ms:\noutput\n");
    expect(partial.commands.map(c => c.exitStatus)).toEqual([-9, 0, null, null]);
    expect(partial.counts.blocksSeen).toBe(4);
    const missingCwd = parseCodexCommands(headers.replace(/ in \/[^\n]+/g, " in") + " succeeded in 0ms:\n");
    expect(missingCwd.commands.map(c => c.cwd)).toEqual([null, null, null, null]);
    expect(missingCwd.commands.map(c => c.flagged)).toEqual([false, false, false, false]);
  });
  it("records an unterminated interpreter and limits a header scan to 200 lines", () => {
    expect(parseCodexCommands("exec\n/bin/zsh -lc 'node server.js' in /repo")).toMatchObject({
      commands: [{ command: "node server.js", cwd: "/repo", exitStatus: null, flagged: true }], counts: { blocksSeen: 1, flagged: 1 }
    });
    const parsed = parseCodexCommands("exec\nnode server.js\n" + "line\n".repeat(201) + " in /beyond-cap\n succeeded in 0ms:\nexec\nrg x in /repo\n succeeded in 0ms:\n");
    expect(parsed.counts.blocksSeen).toBe(2);
    expect(parsed.commands[0]).toMatchObject({ cwd: null, exitStatus: 0 });
    expect(parsed.commands[1]).toMatchObject({ command: "rg x", exitStatus: 0 });
    expect(parsed.truncated).toBe(true);
  });
  it.each([
    "rg x; node y.js", "rg x\nnode y.js", "cat a & node b", "cat <(npm test)", "cat >(node x.js)", "cat $(node x.js)", "cat `node x.js`",
    "find . -exec sh {} \\;", "find . -execdir sh {} +", "find . -ok sh {} \\;", "find . -okdir sh {} +", "find . -fprint out",
    "rg --pre ./x.sh foo", "rg --pre=node foo", "rg --pre-glob=*.ts foo", "rg --hostname-bin=node foo",
    "git -c core.pager=node show", "git --exec-path=/tmp show", "git --upload-pack=node show", "git push",
    "git grep -O./x.sh foo", "git grep --open-files-in-pager=./x.sh foo", "sed -i '' x a", "sed -n '1e node x.js' a",
    "sed -n '1w out' a", "sed -n 's/x/y/e' a", "cat a | xargs cat", "rg x && node y.js", "rg x || node y.js", "cat a >> out"
  ])("flags unsafe command %s", command => {
    expect(parseCodexCommands(`exec\nbash -lc '${command}' in /repo\n exited 1 in 1ms:\n`).commands[0]?.flagged).toBe(true);
  });
  it.each(["rg x && cat a", "rg x || grep x a", "git rev-parse HEAD", "git status", "sed -n -e '1,5p' a"])("accepts read command %s", command => {
    expect(parseCodexCommands(`exec\n/bin/zsh -lc '${command}' in /repo\n succeeded in 1ms:\n`).commands[0]?.flagged).toBe(false);
  });

});

it.each(["darwin", "linux"] as const)("refuses sensitive paths under every %s sandbox root", platform => {
  const system = platform === "darwin" ? ["/etc", "/private/etc", "/usr", "/bin", "/sbin", "/System", "/Library", "/Applications", "/dev"]
    : ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/opt", "/dev", "/proc", "/sys", "/run", "/snap"];
  const dependencies = { platform, readVersion: () => "codex-cli 0.163.0", resolveReadConfinement: () => ({ command: "/tool/codex", readableRoots: ["/checkout", "/tool", "/mirror"] }) };
  for (const kind of ["config", "private key", "state DB", "license key", "evidence"]) {
    for (const dir of [...system, "/checkout", "/tool", "/mirror"]) {
      const result = resolveCheckoutReadsStatus({ checkoutReads: true, cwd: "/checkout", cliPath: "/tool/codex", sensitivePaths: { [kind]: dir + "/neondiff-secret" } }, dependencies);
      expect(result.status).toBe("unavailable:confinement");
      expect(result.detail).toContain("move it outside system directories");
      expect(result.detail).not.toContain(dir + "/neondiff-secret");
    }
  }
  expect(resolveCheckoutReadsStatus({ checkoutReads: true, cwd: "/checkout", cliPath: "/tool/codex", sensitivePaths: { config: "/var/lib/neondiff/config.json" } }, dependencies).status).toBe("enabled");
});
it("resolves sensitive symlinks and missing descendants, and fails closed on unknown platforms", () => {
  const dir = root(), safe = root();
  symlinkSync("/etc", join(dir, "linked"));
  const input = { checkoutReads: true, cwd: safe, cliPath: "/fixture/codex", sensitivePaths: { config: join(dir, "linked/neondiff/missing.json") } };
  const deps = { platform: "linux" as const, readVersion: () => "codex-cli 0.163.0", resolveReadConfinement: () => ({ command: "/fixture/codex", readableRoots: [safe] }) };
  expect(resolveCheckoutReadsStatus(input, deps).status).toBe("unavailable:confinement");
  expect(resolveCheckoutReadsStatus({ ...input, sensitivePaths: { config: "/elsewhere/config" } }, { ...deps, platform: "freebsd" }).status).toBe("unavailable:confinement");
  expect(resolveCheckoutReadsStatus({ ...input, sensitivePaths: { config: join(process.env.HOME!, "config") } }, { ...deps, platform: "freebsd" }).status).toBe("enabled");
});
it("pins a trusted real Codex executable while rejecting absolute and symlinked work-root PATH entries", () => {
  const dir = root(), work = join(dir, "work"), trusted = join(dir, "trusted");
  mkdirSync(work); mkdirSync(trusted);
  for (const base of [work, trusted]) { writeFileSync(join(base, "codex"), "#!/bin/sh\nexit 0\n"); chmodSync(join(base, "codex"), 0o755); }
  symlinkSync(work, join(dir, "alias"));
  const path = ["", ".", work, join(dir, "alias"), trusted].join(":");
  expect(resolveTrustedCodexPath("codex", work, { PATH: path })).toBe(realpathSync(join(trusted, "codex")));
  expect(() => resolveTrustedCodexPath("codex", work, { PATH: [work, join(dir, "alias")].join(":") })).toThrow(/trusted/);
});
