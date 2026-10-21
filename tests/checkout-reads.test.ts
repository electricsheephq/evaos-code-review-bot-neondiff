import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CODEX_REVIEW_FINDINGS_JSON_SCHEMA, CODEX_CHECKOUT_REVIEW_FINDINGS_JSON_SCHEMA, parseCodexCommands, runCodexReview } from "../src/codex-runtime.js";
import { buildSkillPackContextPacket } from "../src/skill-packs.js";
import { verifySourceRef } from "../src/issue-analysis.js";
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
      captureWorktreeState: () => "unchanged", runProcess: async invocation => {
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
      captureWorktreeState: () => "unchanged", runProcess: async invocation => {
        writeFileSync(invocation.outputPath, JSON.stringify({ findings: malformed.map(evidence => ({ ...finding, evidence })), summary }));
        return { stdout: "", stderr: "", status: 0, signal: null };
      }
    });
    expect(result.droppedFromSchema).toEqual([]);
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
  it("parses the captured v0.163 exec block and audits read commands and executable commands", () => {
    expect(parseCodexCommands(fixture("codex-v0163-stderr.txt"))).toMatchObject({ commands: [{ command: "env | cut -d= -f1 | sort", cwd: "/fixture/repo", exitStatus: 0, flagged: true }] });
    const commands = ["rg needle src", "sed -n '1,5p' src/x.ts", "git show HEAD:src/x.ts", "node x.js", "npm test", "bash ./scripts/x.sh", "./node_modules/.bin/x", "find . -delete", "git push", "cat x | python3 -", "git diff > x", "go run x.go"];
    const stderr = commands.map(command => `exec\n/bin/zsh -lc '${command}' in /fixture/repo\n exited 1 in 5ms:\nresult\n`).join("\n");
    const parsed = parseCodexCommands(stderr);
    expect(parsed.commands.map(c => c.flagged)).toEqual([false, false, false, true, true, true, true, true, true, true, true, true]);
    expect(parsed.commands.every(c => c.exitStatus === 1)).toBe(true);
    expect(parseCodexCommands("exec\n/bin/zsh -lc 'rg unfinished' in /fixture/repo\n").commands).toEqual([]);
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
    expect(parseCodexCommands("exec\nrg x in relative\n succeeded in 1ms:\n").commands).toEqual([]);
    expect(parseCodexCommands("exec\n".repeat(200000)).commands).toEqual([]);
    const overflow = parseCodexCommands(block("rg x").repeat(200) + block("node y.js"));
    expect(overflow).toMatchObject({ counts: { total: 201, flagged: 1, blocksSeen: 201, blocksRecorded: 200 }, truncated: true });
  });
  it.each([
    "rg x; node y.js", "cat a & node b", "cat <(npm test)", "cat >(node x.js)", "cat $(node x.js)", "cat `node x.js`",
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
