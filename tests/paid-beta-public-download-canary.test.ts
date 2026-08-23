import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const workflow = readFileSync(".github/workflows/paid-beta-public-download-canary.yml", "utf8");

function feedParser(): string {
  const parsed = YAML.parse(workflow) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> };
  const step = parsed.jobs["public-download-install-canary"].steps.find(
    (candidate) => candidate.name === "Verify version build feed and Sparkle signature agreement"
  );
  const match = step?.run?.match(/python3 - [^\n]+ <<'PY'\n([\s\S]*?)\nPY/);
  if (!match) throw new Error("feed parser is missing");
  return match[1];
}

function runFeed(xml: string, expectedUrl = "https://github.com/example/NeonDiff.zip") {
  const root = mkdtempSync(join(tmpdir(), "neondiff-feed-"));
  const path = join(root, "appcast.xml");
  writeFileSync(path, xml);
  try {
    return spawnSync(
      "python3",
      ["-", path, expectedUrl, "42", "1.1.0-rc.1", "https://www.neondiff.com/updates/beta/appcast.xml", Buffer.alloc(32).toString("base64")],
      { input: feedParser(), encoding: "utf8" }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const validFeed = `<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:other="urn:other"><channel><link>https://www.neondiff.com/updates/beta/appcast.xml</link><item><description>stale build 1.1.0-beta.99</description><sparkle:channel> beta </sparkle:channel><enclosure url="https://github.com/example/NeonDiff.zip" sparkle:version="42" sparkle:shortVersionString="1.1.0-rc.1" sparkle:edSignature="${Buffer.alloc(64).toString("base64")}" /></item><item><description>candidate 1.1.0-rc.1 build 42</description><enclosure url="https://github.com/example/stale.zip" sparkle:version="42" sparkle:shortVersionString="1.1.0-rc.1" /></item></channel></rss>`;

describe("paid beta public download canary", () => {
  it("consumes immutable identity and keeps the workflow read-only", () => {
    expect(workflow).toContain("reviewed_source_sha");
    expect(workflow).toContain("scripts/validate-desktop-release-identity.mjs");
    expect(workflow).toContain("git/ref/tags");
    expect(workflow).toContain("git/tags");
    expect(workflow).toContain("releases/tags");
    expect(workflow).toContain("immutable");
    expect(workflow).toContain("releaseChannel: $releaseChannel");
    expect(workflow).toContain("reviewedSourceSha: $reviewedSourceSha");
    expect(workflow).toContain("http://www.andymatuschak.org/xml-namespaces/sparkle");
    expect(workflow).toContain("isValidSignature");
    expect(workflow).toContain("import CryptoKit");
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./);
    expect(workflow).not.toMatch(/curl[^\n]+--request\s+(post|put|patch|delete)/i);
  });

  it("binds the exact feed item and canonical child channel", () => {
    expect(runFeed(validFeed).status).toBe(0);
    for (const mutation of [
      ["sparkle:channel> beta </sparkle:channel>", "other:channel> beta </other:channel>"],
      ["<sparkle:channel> beta </sparkle:channel>", ""],
      ["</sparkle:channel>", "</sparkle:channel><sparkle:channel>beta</sparkle:channel>"],
      ["<sparkle:channel> beta </sparkle:channel>", "<channel>beta</channel>"],
      ["<sparkle:channel> beta </sparkle:channel>", "<sparkle:channel>candidate</sparkle:channel>"],
      ["url=\"https://github.com/example/NeonDiff.zip\"", "url=\"https://github.com/example/other.zip\""]
    ]) {
      expect(runFeed(validFeed.replace(mutation[0], mutation[1])).status).not.toBe(0);
    }
    expect(runFeed(validFeed.replace("<item>", "<item sparkle:channel=\"beta\">").replace("<sparkle:channel> beta </sparkle:channel>", "")).status).not.toBe(0);
  });
});
