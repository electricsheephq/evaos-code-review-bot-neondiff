import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "scripts/validate-desktop-release-identity.mjs";
const source = "0123456789abcdef0123456789abcdef01234567";
const digest = "a".repeat(64);

function fixture(tag = "v1.1.0-beta.7") {
  const artifact = `NeonDiff-${tag.slice(1)}-build42-macOS.zip`;
  const url = `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/download/${tag}/${artifact}`;
  return {
    tag,
    artifact,
    tagMetadata: { ref: `refs/tags/${tag}`, object: { type: "tag", sha: "abcdef0123456789abcdef0123456789abcdef01" } },
    annotatedTag: { sha: "abcdef0123456789abcdef0123456789abcdef01", tag, object: { type: "commit", sha: source } },
    release: { tag_name: tag, draft: false, prerelease: true, immutable: true, assets: [{ name: artifact, digest: `sha256:${digest}`, browser_download_url: url }] }
  };
}

function run(input: ReturnType<typeof fixture>, extra: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-identity-"));
  const output = join(root, "github-output");
  for (const [name, value] of [["tag", input.tagMetadata], ["annotated", input.annotatedTag], ["release", input.release]] as const) {
    writeFileSync(join(root, `${name}.json`), JSON.stringify(value));
  }
  const args = [script, "--release-tag", input.tag, "--artifact-name", input.artifact, "--artifact-sha256", digest, "--reviewed-source-sha", source, "--tag-metadata", join(root, "tag.json"), "--annotated-tag-metadata", join(root, "annotated.json"), "--release-metadata", join(root, "release.json"), "--github-output", output, ...extra];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  const outputText = existsSync(output) ? readFileSync(output, "utf8") : "";
  rmSync(root, { recursive: true, force: true });
  return { result, outputText };
}

describe("desktop release identity validator", () => {
  it("accepts canonical beta/RC identities and emits bound outputs", () => {
    for (const tag of ["v1.1.0-beta.87", "v1.1.0-rc.1", "v1.1.0-rc.12"]) {
      const result = run(fixture(tag));
      expect(result.result.status, result.result.stderr).toBe(0);
      expect(result.outputText).toContain(`release_version=${tag.slice(1)}`);
      expect(result.outputText).toContain(`reviewed_source_sha=${source}`);
    }
  });

  it("rejects mutable, lightweight, wrong-source, and asset-drift metadata", () => {
    const cases = [
      fixture("v1.1.0-beta.0"),
      fixture("v1.1.0-beta.01"),
      fixture("v1.1.0-beta.10000"),
      fixture("v1.1.0-rc.0"),
      fixture("v1.1.0-rc.01"),
      { ...fixture(), tagMetadata: { ...fixture().tagMetadata, object: { type: "commit", sha: source } } },
      { ...fixture(), annotatedTag: { ...fixture().annotatedTag, sha: "fedcba9876543210fedcba9876543210fedcba98" } },
      { ...fixture(), annotatedTag: { ...fixture().annotatedTag, tag: "v1.1.0-beta.6" } },
      { ...fixture(), annotatedTag: { object: { type: "commit", sha: "fedcba9876543210fedcba9876543210fedcba98" } } },
      { ...fixture(), release: { ...fixture().release, immutable: false } },
      { ...fixture(), release: { ...fixture().release, assets: [{ ...fixture().release.assets[0], digest: `sha256:${"b".repeat(64)}` }] } }
    ];
    for (const input of cases) expect(run(input).result.status).not.toBe(0);
  });
});
