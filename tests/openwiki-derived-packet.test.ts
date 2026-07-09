import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildOpenWikiDerivedRepoWikiPacket } from "../src/openwiki-derived-packet.js";
import { buildRepoWikiContextPacket } from "../src/repo-wiki-context.js";
import { formatRepoWikiPacketJson } from "../src/repo-wiki-packet.js";

const repo = "electricsheephq/evaos-code-review-bot-neondiff";
const generatedAt = "2026-07-09T08:30:00.000Z";

describe("OpenWiki-derived repo-wiki packets", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("curates OpenWiki Markdown into the deterministic NeonDiff packet shape", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet).toMatchObject({
      packetVersion: "repo-wiki-packet-v0.1",
      repo: { fullName: repo, defaultBranch: "main" },
      source: { headSha: head, status: "fresh" },
      degraded: false
    });
    expect(packet.includedSections.map((section) => section.id)).toEqual(["quickstart"]);
    const section = packet.includedSections[0];
    expect(section?.sourceFiles).toEqual([
      "README.md",
      "openwiki/quickstart.md",
      "src/worker.ts"
    ]);
    expect(section?.body).toContain("[redacted-secret]");
    expect(section?.body).not.toContain("OPENROUTER_API_KEY");
    expect(section?.sourceSha).toBe(sha256(section?.body ?? ""));
    expect(packet.redaction).toMatchObject({
      status: "redacted",
      replacementCount: 1
    });

    mkdirSync(join(root, ".neondiff"), { recursive: true });
    writeFileSync(join(root, ".neondiff", "repo-wiki-packet.json"), formatRepoWikiPacketJson(packet));
    const contextPacket = buildRepoWikiContextPacket({
      repo,
      worktreePath: root,
      config: {
        enabled: true,
        packetPath: ".neondiff/repo-wiki-packet.json",
        maxPacketBytes: 12_000,
        includeStaleContext: false
      },
      expectedHeadSha: head
    });
    expect(contextPacket.packet).toMatchObject({
      repoWiki: {
        freshness: "fresh",
        degradedMode: false
      }
    });
  });

  it("marks OpenWiki packets stale when metadata is not source-backed", () => {
    const { root } = createRepoWithOpenWiki({ metadataHead: "old-head" });
    roots.push(root);

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: "current-head",
      defaultBranch: "main"
    });

    expect(packet.source).toMatchObject({
      status: "stale",
      staleReason: "OpenWiki metadata gitHead does not match the current repository head."
    });
    expect(packet.degraded).toBe(true);
  });

  it("does not treat the standard packet artifact as stale source", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);
    mkdirSync(join(root, ".neondiff"), { recursive: true });
    writeFileSync(join(root, ".neondiff", "repo-wiki-packet.json"), "{}\n", "utf8");

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet.source).toMatchObject({
      headSha: head,
      status: "fresh"
    });
  });

  it("omits OpenWiki review suggestions from prompt packets", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);
    mkdirSync(join(root, "openwiki", "_review"), { recursive: true });
    writeFileSync(join(root, "openwiki", "_review", "suggested-doc-edits.md"), "# Suggested edits\n", "utf8");

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet.includedSections.map((section) => section.id)).toEqual(["quickstart"]);
    expect(formatRepoWikiPacketJson(packet)).not.toContain("suggested-doc-edits");
  });

  it("redacts sensitive env names that start with the sensitive keyword", () => {
    const { head, root } = createRepoWithOpenWiki({
      openWikiBody: [
        "# Provider setup",
        "",
        "Use API_KEY, PRIVATE_KEY, SESSION_COOKIE, and ZAI_TOKEN only in GitHub secrets.",
        "Bare prose words like TOKEN, SECRET, PASSWORD, COOKIE, and SESSION should stay readable.",
        ""
      ].join("\n")
    });
    roots.push(root);

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });
    const body = packet.includedSections[0]?.body ?? "";

    expect(body).toContain("[redacted-secret]");
    expect(body).not.toContain("API_KEY");
    expect(body).not.toContain("PRIVATE_KEY");
    expect(body).not.toContain("SESSION_COOKIE");
    expect(body).not.toContain("ZAI_TOKEN");
    expect(body).toContain("TOKEN, SECRET, PASSWORD, COOKIE, and SESSION should stay readable.");
    expect(packet.redaction).toMatchObject({
      status: "redacted",
      replacementCount: 4
    });
  });

  it("marks packets stale when dirty git status renames OpenWiki files into source docs", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    git(root, ["mv", "openwiki/quickstart.md", "docs/quickstart.md"]);
    writeFileSync(join(root, "openwiki", "replacement.md"), "# Replacement\n\nStill advisory.\n", "utf8");

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet.source).toMatchObject({
      status: "stale",
      staleReason: "Repository has non-openwiki worktree changes; regenerate OpenWiki before building a packet."
    });
    expect(packet.degraded).toBe(true);
  });

  it("marks packets stale when untracked non-openwiki files exist", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "new-guide.md"), "# New Guide\n", "utf8");

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet.source).toMatchObject({
      status: "stale",
      staleReason: "Repository has non-openwiki worktree changes; regenerate OpenWiki before building a packet."
    });
  });

  it("fails closed when git status cannot be read", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);
    rmSync(join(root, ".git"), { recursive: true, force: true });

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet.source).toMatchObject({
      status: "stale",
      staleReason: "Unable to read git worktree status; regenerate OpenWiki before building a packet."
    });
    expect(packet.degraded).toBe(true);
  });

  it("marks packets missing when OpenWiki has no Markdown sections", () => {
    const { head, root } = createRepoWithOpenWiki();
    roots.push(root);
    rmSync(join(root, "openwiki", "quickstart.md"));

    const packet = buildOpenWikiDerivedRepoWikiPacket({
      repo,
      worktreePath: root,
      generatedAt,
      headSha: head,
      defaultBranch: "main"
    });

    expect(packet.source).toMatchObject({
      status: "missing",
      staleReason: "No OpenWiki Markdown files were found under openwiki/."
    });
  });
});

function createRepoWithOpenWiki(options: { metadataHead?: string; openWikiBody?: string } = {}): { head: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "neondiff-openwiki-derived-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "NeonDiff Test"]);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "openwiki"), { recursive: true });
  writeFileSync(join(root, "README.md"), "# NeonDiff\n", "utf8");
  writeFileSync(join(root, "src", "worker.ts"), "export const worker = true;\n", "utf8");
  writeFileSync(
    join(root, "openwiki", "quickstart.md"),
    options.openWikiBody ??
      [
        "# Quickstart",
        "",
        "NeonDiff reviews pull requests. Configure provider credentials with OPENROUTER_API_KEY.",
        "",
        "## Source map",
        "",
        "- README.md",
        "- src/worker.ts",
        "- Git evidence: commits `abc1234`",
        ""
      ].join("\n"),
    "utf8"
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const head = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(root, "openwiki", ".last-update.json"),
    `${JSON.stringify({
      updatedAt: generatedAt,
      command: "update",
      gitHead: options.metadataHead ?? head,
      model: "GLM-5.2"
    })}\n`,
    "utf8"
  );
  return { head, root };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
