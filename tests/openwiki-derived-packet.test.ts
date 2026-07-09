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
    expect(packet.includedSections[0]?.sourceFiles).toEqual([
      "README.md",
      "openwiki/quickstart.md",
      "src/worker.ts"
    ]);
    expect(packet.includedSections[0]?.body).toContain("[redacted-secret]");
    expect(packet.includedSections[0]?.body).not.toContain("OPENROUTER_API_KEY");
    expect(packet.includedSections[0]?.sourceSha).toMatch(/^[a-f0-9]{64}$/);

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
});

function createRepoWithOpenWiki(options: { metadataHead?: string } = {}): { head: string; root: string } {
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
